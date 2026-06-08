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
  | "analysis-evidence"
  | "c-embedded-evidence"
  | "source-comment"
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
  analysisEvidenceText?: string
  tokenBudget?: number
}

export function packCompletionContext(input: PackCompletionContextInput): CompletionContextPack {
  const tokenBudget = input.tokenBudget ?? tokenBudgetForPlan(input.plan)
  const blocks = contextBlocks(input).sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
  if (input.plan.kind === "c-embedded-code" || input.plan.kind === "comment-guided-c-code") return packCEmbeddedContextBlocks(blocks, tokenBudget, input.plan)

  return packGreedyContextBlocks(blocks, tokenBudget)
}

function packGreedyContextBlocks(blocks: PackedContextBlock[], tokenBudget: number): CompletionContextPack {
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

function packCEmbeddedContextBlocks(blocks: PackedContextBlock[], tokenBudget: number, plan: CompletionPlan): CompletionContextPack {
  const selected: PackedContextBlock[] = []
  const dropped: PackedContextBlock[] = []
  const selectedSet = new Set<PackedContextBlock>()
  const evidenceLimit = promptEvidenceLimitForPlan(plan)
  const evidenceTokenLimit = promptEvidenceTokenLimitForPlan(plan)
  let selectedEvidence = 0
  let selectedEvidenceTokens = 0
  let tokenEstimate = 0

  const trySelect = (block: PackedContextBlock | undefined) => {
    if (!block || block.tokenEstimate <= 0 || selectedSet.has(block)) return false
    const evidenceBlock = isCompletionEvidenceContextBlock(block)
    if (evidenceBlock && selectedEvidence >= evidenceLimit) return false
    if (evidenceBlock && selectedEvidenceTokens + block.tokenEstimate > evidenceTokenLimit) return false
    if (tokenEstimate + block.tokenEstimate > tokenBudget) return false
    selected.push(block)
    selectedSet.add(block)
    if (evidenceBlock) {
      selectedEvidence += 1
      selectedEvidenceTokens += block.tokenEstimate
    }
    tokenEstimate += block.tokenEstimate
    return true
  }

  trySelect(blocks.find((block) => block.kind === "current-prefix"))
  trySelect(blocks.find((block) => block.kind === "current-suffix"))
  trySelect(blocks.find((block) => block.kind === "source-comment"))
  for (const block of blocks.filter(isCompletionEvidenceContextBlock)) {
    trySelect(block)
  }
  for (const block of blocks) {
    trySelect(block)
  }
  for (const block of blocks) {
    if (!selectedSet.has(block) && block.tokenEstimate > 0) dropped.push(block)
  }

  selected.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))

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
  const evidence = pack.selected.filter((block) => block.kind === "analysis-evidence")
  const current = pack.selected.filter((block) => block.kind === "current-prefix" || block.kind === "current-suffix")

  return [
    section("Target symbol", target),
    section("Similar tests", tests),
    section("Test framework context", framework),
    section("Local analysis evidence", evidence),
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
  const similarTests = snippets.filter(isSimilarTest).map((snippet, index) => snippetBlock(snippet, "similar-test", 760 - index, input.plan))
  const testFramework = testFrameworkBlocks(input.plan, snippets)
  const includes = includeBlock(input.prefix, input.currentPath)
  const analysisEvidence = analysisEvidenceBlocks(input)
  const current = currentFileBlocks(input)
  const openTabs = openTabBlocks(input)
  const sourceComment = sourceCommentBlock(input)

  switch (input.plan.kind) {
    case "symbol-completion":
      return target.length > 0 ? target : snippets.slice(0, 8).map((snippet, index) => snippetBlock(snippet, "target-symbol", 700 - index, input.plan))
    case "comment-symbol-reference":
      return target
    case "previous-comment-continuation":
      return input.plan.needsTestRetrieval
        ? [...target, ...similarTests, ...testFramework, ...includes, ...analysisEvidence, ...openTabs, ...current]
        : [...target, ...includes, ...analysisEvidence, ...openTabs, ...current]
    case "comment-to-test":
      return [...target, ...similarTests, ...testFramework, ...includes, ...analysisEvidence, ...openTabs, ...current]
    case "natural-command":
      return [...target, ...similarTests, ...testFramework, ...analysisEvidence, ...openTabs, ...current]
    case "ordinary-code":
    case "c-embedded-code":
    case "comment-guided-c-code":
    case "body-continuation":
    case "top-level-declaration":
      return [...target, ...sourceComment, ...includes, ...analysisEvidence, ...openTabs, ...current]
    case "comment-to-code":
      return [...target, ...includes, ...analysisEvidence, ...openTabs, ...current]
    case "disabled":
      return []
  }
}

function targetSymbolBlocks(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]) {
  if (plan.kind === "comment-guided-c-code") {
    const target = plan.targetSymbol?.toLowerCase()
    if (!target) return []
    const exact = snippets.find((snippet) => snippet.name?.toLowerCase() === target)
    return exact ? [snippetBlock(exact, "target-symbol", 900, plan)] : []
  }
  const target = plan.targetSymbol?.toLowerCase()
  const preferred = snippets.filter((snippet) => {
    if (!snippet.name) return false
    if (!target) return !isSimilarTest(snippet)
    const name = snippet.name.toLowerCase()
    return name === target || name.startsWith(target) || target.startsWith(name)
  })
  const fallback = preferred.length > 0 ? preferred : rankSnippetsForIntent(plan, snippets.filter((snippet) => !isSimilarTest(snippet))).slice(0, 3)
  return fallback.map((snippet, index) => snippetBlock(snippet, "target-symbol", 900 - index, plan))
}

function snippetBlock(snippet: RetrievedCompletionSnippet, kind: PackedContextBlockKind, score: number, plan?: CompletionPlan): PackedContextBlock {
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
    score: score + Math.min(Math.max(snippet.score ?? 0, 0), 100) + cIntentSnippetBoost(plan, snippet),
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
  const ordinary = input.plan.kind === "ordinary-code" ||
    input.plan.kind === "c-embedded-code" ||
    input.plan.kind === "comment-guided-c-code" ||
    input.plan.kind === "body-continuation" ||
    input.plan.kind === "top-level-declaration"
  const cEmbeddedWithEvidence = (input.plan.kind === "c-embedded-code" || input.plan.kind === "comment-guided-c-code") && Boolean(input.analysisEvidenceText?.trim())
  const currentPrefix = tailLines(input.prefix, cEmbeddedWithEvidence ? 44 : ordinary ? 60 : 120)
  const currentSuffix = headLines(input.suffix, cEmbeddedWithEvidence ? 24 : ordinary ? 40 : 80)
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

function sourceCommentBlock(input: PackCompletionContextInput): PackedContextBlock[] {
  const sourceComment = input.plan.sourceComment?.trim()
  if (!sourceComment || input.plan.kind !== "comment-guided-c-code") return []
  return [
    block({
      kind: "source-comment",
      title: "source comment",
      filePath: input.currentPath,
      text: sourceComment,
      score: 760,
    }),
  ]
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

function analysisEvidenceBlocks(input: PackCompletionContextInput): PackedContextBlock[] {
  const text = input.analysisEvidenceText?.trim()
  if (!text) return []
  if (input.plan.kind === "c-embedded-code" || input.plan.kind === "comment-guided-c-code") {
    const cEvidence = cEmbeddedEvidenceBlocks(input, text)
    if (cEvidence.length > 0) return cEvidence
    return splitAnalysisEvidenceText(text, 1200).slice(0, 4).map((chunk, index) =>
      block({
        kind: "analysis-evidence",
        title: index === 0 ? "local analysis evidence" : `local analysis evidence ${index + 1}`,
        filePath: input.currentPath,
        text: limitSnippetText(chunk, "analysis-evidence"),
        score: 700 - index * 8 + cIntentEvidenceBoost(input.plan, chunk),
      }))
  }
  return [
    block({
      kind: "analysis-evidence",
      title: "local analysis evidence",
      filePath: input.currentPath,
      text: limitSnippetText(text, "analysis-evidence"),
      score: (input.plan.useInstruction ? 700 : 610) + cIntentEvidenceBoost(input.plan, text),
    }),
  ]
}

function cEmbeddedEvidenceBlocks(input: PackCompletionContextInput, text: string): PackedContextBlock[] {
  if (!/^C evidence:\s*c-[A-Za-z0-9-]+/m.test(text)) return []
  const blocks: PackedContextBlock[] = []
  for (const section of splitCEmbeddedEvidenceSections(text)) {
    const meta = parseCEmbeddedEvidenceSection(section, input.currentPath)
    const title = [meta.kind, meta.symbol].filter(Boolean).join(": ")
    blocks.push(block({
      kind: "c-embedded-evidence",
      title: title || "c embedded evidence",
      filePath: meta.path,
      text: input.plan.kind === "comment-guided-c-code"
        ? limitText(section.trim(), 620)
        : limitSnippetText(section.trim(), "c-embedded-evidence"),
      score: 780 +
        Math.min(Number.isFinite(meta.score) ? Math.max(meta.score, 0) : 0, 120) +
        cEmbeddedEvidencePromptBoost(meta) +
        cIntentEvidenceBoost(input.plan, section),
    }))
  }
  return blocks
}

function splitCEmbeddedEvidenceSections(text: string) {
  const sections: string[] = []
  const lines = text.split(/\r?\n/)
  let current: string[] = []
  for (const line of lines) {
    if (/^C evidence:\s*c-[A-Za-z0-9-]+/.test(line)) {
      if (current.length) sections.push(current.join("\n"))
      current = [line]
      continue
    }
    if (current.length) current.push(line)
  }
  if (current.length) sections.push(current.join("\n"))
  return sections
}

function parseCEmbeddedEvidenceSection(section: string, currentPath: string) {
  const kind = /^C evidence:\s*(c-[A-Za-z0-9-]+)/m.exec(section)?.[1] ?? "c-evidence"
  const symbol = /^Symbol:\s*(.+)$/m.exec(section)?.[1]?.trim()
  const source = /^Source:\s*(.+):(\d+)(?:-\d+)?$/m.exec(section)
  const role = /^Evidence role:\s*([A-Za-z0-9-]+)/m.exec(section)?.[1]?.trim()
  const helperConfidence = /^Helper callable confidence:\s*([A-Za-z0-9-]+)/m.exec(section)?.[1]?.trim()
  const score = Number(/^Score:\s*(\d+)/m.exec(section)?.[1] ?? 0)
  return {
    kind,
    symbol,
    path: source?.[1] ?? currentPath,
    role,
    helperConfidence,
    score,
  }
}

function cEmbeddedEvidencePromptBoost(meta: ReturnType<typeof parseCEmbeddedEvidenceSection>) {
  let boost = 0
  switch (meta.role) {
    case "callable-helper":
      boost += 70
      break
    case "style-example":
      boost += 20
      break
    case "local-flow":
      boost += 10
      break
    default:
      break
  }
  switch (meta.helperConfidence) {
    case "high":
      boost += 30
      break
    case "medium":
      boost += 15
      break
    default:
      break
  }
  return boost
}

function splitAnalysisEvidenceText(input: string, maxChars: number) {
  const chunks: string[] = []
  const lines = input.split(/\r?\n/)
  let current = ""
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line
    if (next.length > maxChars && current) {
      chunks.push(current)
      current = line
    } else {
      current = next
    }
  }
  if (current.trim()) chunks.push(current)
  return chunks.length > 0 ? chunks : [input]
}

function rankSnippetsForIntent(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[]) {
  return [...snippets].sort((left, right) =>
    cIntentSnippetBoost(plan, right) - cIntentSnippetBoost(plan, left) ||
    (right.score ?? 0) - (left.score ?? 0) ||
    (left.path || "").localeCompare(right.path || "") ||
    (left.name || "").localeCompare(right.name || ""))
}

function cIntentSnippetBoost(plan: CompletionPlan | undefined, snippet: RetrievedCompletionSnippet) {
  if (!plan?.cIntent) return 0
  const haystack = `${snippet.kind}\n${snippet.name ?? ""}\n${snippet.path}\n${snippet.text}`
  switch (plan.cIntent) {
    case "member-access":
      return (/\b(?:type|struct|union|typedef)\b/i.test(snippet.kind) ? 120 : 0) +
        (/(?:->|\.)[A-Za-z_][A-Za-z0-9_]*/.test(haystack) ? 70 : 0)
    case "call-args":
      return (/\bfunction\b/i.test(snippet.kind) ? 120 : 0) +
        (snippet.name && new RegExp(`\\b${escapeRegExp(snippet.name)}\\s*\\(`).test(snippet.text) ? 60 : 0)
    case "initializer":
      return (/\b(?:type|struct|union|typedef)\b/i.test(snippet.kind) ? 100 : 0) +
        (/\.[A-Za-z_][A-Za-z0-9_]*\s*=/.test(snippet.text) ? 100 : 0)
    case "condition":
    case "state-machine":
      return (/\b(?:enum|state|status|flags?)\b/i.test(haystack) ? 90 : 0) +
        (/\b(?:if|while)\s*\(/.test(snippet.text) ? 70 : 0)
    case "error-path":
      return (/^[ \t]*[A-Za-z_][A-Za-z0-9_]*:\s*$/m.test(snippet.text) ? 120 : 0) +
        (/\bgoto\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(snippet.text) ? 120 : 0) +
        (/\breturn\s+(?:ret|retval|err|errno|rc|status)\s*;/.test(snippet.text) ? 60 : 0)
    case "mmio-register":
      return (/\b(?:macro|global)\b/i.test(snippet.kind) ? 140 : 0) +
        (/\b(?:BIT|GENMASK|FIELD_PREP|FIELD_GET|readl|writel|ioread|iowrite|volatile|barrier)\b/.test(haystack) ? 140 : 0) +
        (/\b[A-Z][A-Z0-9_]*(?:_REG|_MASK|_SHIFT|_BIT|_BITS)\b/.test(haystack) ? 100 : 0)
    case "case-body":
    case "switch-case":
      return (/\b(?:case|default)\b.*:/.test(snippet.text) ? 100 : 0) +
        (/\b(?:enum|state|status)\b/i.test(haystack) ? 80 : 0)
    default:
      return 0
  }
}

function cIntentEvidenceBoost(plan: CompletionPlan, text: string) {
  switch (plan.cIntent) {
    case "member-access":
      return /\b(?:struct-field|fields?:|member-base|member-prefix)\b/i.test(text) ? 140 : 0
    case "call-args":
      return /\b(?:call-site|return-handling|argument order|callee)\b/i.test(text) ? 130 : 0
    case "initializer":
      return /\b(?:initializer-example|initializer type|fields?:|\.[A-Za-z_][A-Za-z0-9_]*\s*=)\b/i.test(text) ? 130 : 0
    case "error-path":
      return /\b(?:cleanup-label|cleanup|label|goto|return\s+(?:ret|err|rc|status)|unlock|free|release)\b/i.test(text) ? 130 : 0
    case "mmio-register":
      return /\b(?:register-family|register|mmio|macro|bit|mask|shift|readl|writel|volatile|barrier)\b/i.test(text) ? 130 : 0
    case "condition":
    case "state-machine":
    case "case-body":
    case "switch-case":
      return /\b(?:state-context|condition|state|enum|status|flag|guard|transition)\b/i.test(text) ? 100 : 0
    default:
      return 0
  }
}

function block(input: Omit<PackedContextBlock, "tokenEstimate">): PackedContextBlock {
  return {
    ...input,
    tokenEstimate: estimateTokens(input.text),
  }
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
    case "analysis-evidence":
      return 3200
    case "c-embedded-evidence":
      return 900
    default:
      return 3000
  }
}

function isCompletionEvidenceContextBlock(block: PackedContextBlock) {
  return block.kind === "c-embedded-evidence" || block.kind === "analysis-evidence"
}

function promptEvidenceLimitForPlan(plan: CompletionPlan) {
  if (plan.kind === "comment-guided-c-code") return 3
  switch (plan.cIntent) {
    case "member-access":
    case "call-args":
    case "initializer":
    case "error-path":
    case "state-machine":
    case "mmio-register":
      return 4
    default:
      return 2
  }
}

function promptEvidenceTokenLimitForPlan(plan: CompletionPlan) {
  return plan.kind === "comment-guided-c-code" ? 450 : Number.POSITIVE_INFINITY
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
    case "comment-guided-c-code":
      return 900
    case "comment-to-test":
    case "natural-command":
      return 1800
    case "ordinary-code":
    case "c-embedded-code":
    case "body-continuation":
    case "top-level-declaration":
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

function limitText(input: string, maxChars: number) {
  const normalized = input.trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).replace(/\s+$/, "")}\n/* completion context truncated */`
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
