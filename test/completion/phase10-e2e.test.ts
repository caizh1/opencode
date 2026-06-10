import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseCFile } from "../../src/codegraph-c-parser"
import { searchCodeGraphSymbols } from "../../src/codegraph-query"
import type { CodeGraphIndex } from "../../src/codegraph-types"
import { runCompletionCandidatePipeline } from "../../src/completion-candidate-pipeline"
import { adaptAndValidateInlineCompletionEdit, buildInlineCompletionEditResult, type CompletionRange } from "../../src/completion-edit"
import { inferCompletionIndent } from "../../src/completion-indent"
import { postprocessCompletion } from "../../src/completion-postprocess"
import { planCompletion } from "../../src/completion-plan"
import { routeCompletionModel, shouldRetryCompletionRejection } from "../../src/completion-router"
import { resolveSymbols, symbolCandidateFromCodeGraph, type ResolvedSymbolCandidate } from "../../src/completion-symbol"
import { fallbackCompletionText } from "../../src/completion-test-fallback"
import { completionInsertText } from "../../src/completion-text"
import type { CompletionPlan, RetrievedCompletionSnippet } from "../../src/completion-types"
import type { CompletionModelMessage } from "../../src/completion-model-client"
import type { RemoteSettings } from "../../src/types"

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "c")
const TARGET_SYMBOL = "epr_ppn_raw_write_with_cb_dfx"
const COMMENT_SYMBOL = "epr_ppn_raw_write_cb_dfx"

describe("phase 10 completion e2e fixtures", () => {
  test("natural language unit-test command resolves a symbol and replaces the whole line", () => {
    const line = "unit test for epr_ppn_raw_wr"
    const snapshot = runCompletionE2E({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: line,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "natural-command",
      insertMode: "replace-whole-line",
      selectedSymbol: TARGET_SYMBOL,
      modelRoute: "instruction",
    })
    expect(snapshot.insertText).toContain(`test_${TARGET_SYMBOL}`)
    expect(snapshot.insertText).not.toContain(line)
    expect(snapshot.finalRange).toEqual({
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: line.length,
    })
    expect(snapshot.rejectionReason).toBeUndefined()
  })

  test("comment-to-test inserts generated test code after the current comment", () => {
    const line = `// unit test for ${COMMENT_SYMBOL}()`
    const rawModelText = `${line}\nstatic void test_${COMMENT_SYMBOL}(void) {\n}`
    const snapshot = runCompletionE2E({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "comment-to-test",
      insertMode: "insert-after-line",
      modelRoute: "instruction",
      selectedSymbol: COMMENT_SYMBOL,
    })
    expect(snapshot.insertText?.startsWith("\n")).toBe(true)
    expect(snapshot.insertText).toContain(`test_${COMMENT_SYMBOL}`)
    expect(snapshot.insertText).not.toContain(line)
    expect(snapshot.rejectionReason).toBeUndefined()
  })

  test("ordinary code completion uses Qwen FIM instead of instruction routing", () => {
    const line = "    if (ret != 0) {"
    const snapshot = runCompletionE2E({
      documentText: `int main(void)\n{\n${line}\n    }\n}\n`,
      line: 2,
      character: line.length,
      rawModelText: "\nreturn ret;",
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "c-embedded-code",
      modelRoute: "fim",
      modelCalled: true,
    })
  })

  test("generic embedded C top-level declarations use Qwen FIM", () => {
    const snapshot = runCompletionE2E({
      documentText: "#include <stdint.h>\n\nextern void sensor_driver_probe(void);\n",
      line: 1,
      character: 0,
      rawModelText: "static volatile uint32_t * const sensor_status_reg = (volatile uint32_t *)0x40001000u;",
      languageId: "c",
      relatedPath: "src/drivers/sensor_driver.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "c-embedded-code",
      modelRoute: "fim",
      modelCalled: true,
      rejectionReason: undefined,
    })
    expect(snapshot.insertText).toContain("sensor_status_reg")
  })

  test("high-confidence symbol completion uses deterministic resolver without calling the model", () => {
    const line = "    epr_ppn_raw_wr"
    const snapshot = runCompletionE2E({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: "unused model output",
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "c-embedded-code",
      selectedSymbol: TARGET_SYMBOL,
      modelRoute: "deterministic-symbol",
      modelCalled: false,
      insertText: "ite_with_cb_dfx",
      finalRange: {
        startLine: 0,
        startCharacter: line.length,
        endLine: 0,
        endCharacter: line.length,
      },
    })
  })

  test("middle-of-line suffix overlap does not duplicate closing punctuation", () => {
    const snapshot = runCompletionE2E({
      documentText: "foo();\n",
      line: 0,
      character: "foo(".length,
      rawModelText: `${TARGET_SYMBOL}());`,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      normalizedText: `${TARGET_SYMBOL}()`,
      finalLine: `foo(${TARGET_SYMBOL}());`,
      rejectionReason: undefined,
    })
  })

  test("middle-of-line suffix echo is rejected before it can render bad ghost text", () => {
    const snapshot = runCompletionE2E({
      documentText: "    return ;\n",
      line: 0,
      character: "    return ".length,
      rawModelText: ";\n}",
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      normalizedText: "",
      insertText: undefined,
      finalLine: undefined,
      rejectionReason: "suffix-duplicated-output",
    })
  })

  test("previous comment test continuation uses deterministic fallback after low-confidence output", () => {
    const comment = `// in order to test ${COMMENT_SYMBOL}`
    const line = "stat"
    const snapshot = runCompletionE2E({
      documentText: `${comment}\n${line}\n`,
      line: 1,
      character: line.length,
      rawModelText: "{}",
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      planKind: "previous-comment-continuation",
      insertMode: "replace-whole-line",
      selectedSymbol: COMMENT_SYMBOL,
      modelRoute: "instruction",
    })
    expect(snapshot.insertText).toContain(`test_${COMMENT_SYMBOL}`)
    expect(snapshot.insertText).toContain(`${COMMENT_SYMBOL}();`)
    expect(snapshot.rejectionReason).toBeUndefined()
  })

  test("comment-to-code retries generic success returns before showing ghost code", () => {
    const documentText = [
      "static int driver_open(Device *dev)",
      "{",
      "    int ret;",
      "    // Add project-style error cleanup before success return.",
      "    ",
      "    ret = driver_start(dev);",
      "    if (ret < 0) {",
      "        return ret;",
      "    }",
      "    return 0;",
      "}",
    ].join("\n")
    const first = runPipelineForDocument({
      documentText,
      line: 4,
      character: 4,
      rawText: "return 0;",
      languageId: "c",
      plan: commentToCodeInstructionPlan("// Add project-style error cleanup before success return."),
    })

    expect(first.result).toMatchObject({
      decision: "rejected",
      rejectionReason: "low-intent-output",
    })
    expect(shouldRetryCompletionRejection({
      reason: first.result.rejectionReason ?? "",
      plan: first.plan,
      textProfile: "generic-chat",
    })).toBe(true)

    const retry = runPipelineForDocument({
      documentText,
      line: 4,
      character: 4,
      rawText: [
        "ret = driver_prepare(dev);",
        "if (ret < 0) {",
        "    return ret;",
        "}",
      ].join("\n"),
      languageId: "c",
      plan: commentToCodeInstructionPlan("// Add project-style error cleanup before success return."),
    })

    expect(retry.result).toMatchObject({
      decision: "accepted",
    })
    expect(retry.result.edit?.insertText).toContain("driver_prepare")
  })

  test("comment-to-code rejects direct copies of the following suffix", () => {
    const documentText = [
      "static int driver_open(Device *dev)",
      "{",
      "    // Add project-style error cleanup before success return.",
      "    ",
      "    ret = driver_start(dev);",
      "    return 0;",
      "}",
    ].join("\n")
    const snapshot = runPipelineForDocument({
      documentText,
      line: 3,
      character: 4,
      rawText: "ret = driver_start(dev);\nif (ret < 0) {\n    return ret;\n}",
      languageId: "c",
      plan: commentToCodeInstructionPlan("// Add project-style error cleanup before success return."),
    })

    expect(snapshot.result).toMatchObject({
      decision: "rejected",
      rejectionReason: "suffix-duplicated-output",
    })
  })
})

type E2EInput = {
  documentText: string
  line: number
  character: number
  rawModelText: string
  languageId: string
  relatedPath: string
  triggerKind?: "automatic" | "manual" | "invoke" | string
}

type E2ESnapshot = {
  planKind: CompletionPlan["kind"]
  insertMode: CompletionPlan["insertMode"]
  selectedSymbol?: string
  modelRoute: "fim" | "instruction" | "deterministic-symbol"
  modelCalled: boolean
  rawText: string
  normalizedText: string
  insertText?: string
  finalRange?: CompletionRange
  rejectionReason?: string
  finalLine?: string
}

function runCompletionE2E(input: E2EInput): E2ESnapshot {
  const document = fakeTextDocument(input.documentText, input.languageId)
  const position = { line: input.line, character: input.character }
  const lineText = document.lineAt(position.line).text
  const linePrefix = lineText.slice(0, position.character)
  const lineSuffix = lineText.slice(position.character)
  const currentWord = currentWordBeforeCursor(linePrefix)
  const indent = inferCompletionIndent({
    lines: document.lines,
    line: position.line,
    linePrefix,
    fallbackIndentUnit: "    ",
  })
  const plan = planCompletion({
    languageId: document.languageId,
    linePrefix,
    lineSuffix,
    currentWord: currentWord?.text,
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
    nextNonEmptyLine: nextNonEmptyLineAfter(document.lines, position.line),
    lines: document.lines,
    line: position.line,
    triggerKind: input.triggerKind ?? "automatic",
  })
  const selectedSymbol = retrieveSymbolCandidate({
    query: plan.targetSymbol ?? currentWord?.text ?? lastIdentifier(linePrefix),
    relatedPath: input.relatedPath,
    unitTestTarget: plan.needsTestRetrieval,
  })
  const retrievedSnippets = selectedSymbol ? [symbolSnippet(selectedSymbol)] : []
  const route = routeCompletionModel({
    plan,
    settings: settings(),
    retrievedSnippets,
  })
  const rawText = route.kind === "deterministic-symbol"
    ? route.text
    : completionInsertText(modelMessage(input.rawModelText), route.textProfile)
  const postprocessResult = postprocessCompletion({
    rawText,
    linePrefix,
    lineSuffix,
    currentWord: currentWord?.text,
    fullCurrentLine: lineText,
    languageId: document.languageId,
    plan,
    indent: {
      currentIndent: lineIndent(linePrefix),
      targetIndent: indent.targetIndent,
      indentUnit: indent.indentUnit,
    },
  })
  const normalizedText = postprocessResult.text
  const editText = normalizedText || fallbackCompletionText({
    languageId: document.languageId,
    plan,
    retrievedSnippets,
    rejectReason: postprocessResult.reason,
  })
  const editResult = buildInlineCompletionEditResult({
    text: editText,
    languageId: document.languageId,
    linePrefix,
    lineSuffix,
    position,
    indent,
    currentWord: currentWord?.text,
    currentWordRange: currentWord?.range(position.line),
    plan,
  })
  const adaptedResult = editResult.edit
    ? adaptAndValidateInlineCompletionEdit({
        edit: editResult.edit,
        editInput: {
          languageId: document.languageId,
          linePrefix,
          lineSuffix,
          position,
          indent,
          currentWord: currentWord?.text,
          currentWordRange: currentWord?.range(position.line),
        },
        plan,
      })
    : undefined
  const edit = adaptedResult?.status === "ok" ? adaptedResult.edit : undefined

  return {
    planKind: plan.kind,
    insertMode: plan.insertMode,
    selectedSymbol: selectedSymbol?.name,
    modelRoute: route.kind === "deterministic-symbol" ? "deterministic-symbol" : route.promptKind === "qwen-fim" ? "fim" : "instruction",
    modelCalled: route.kind !== "deterministic-symbol",
    rawText,
    normalizedText,
    insertText: edit?.insertText,
    finalRange: edit?.replaceRange,
    rejectionReason: edit ? undefined : postprocessResult.reason ?? adaptedResult?.reason ?? editResult.reason,
    finalLine: edit ? applySingleLineEdit(lineText, edit.replaceRange, edit.insertText) : undefined,
  }
}

function runPipelineForDocument(input: {
  documentText: string
  line: number
  character: number
  rawText: string
  languageId: string
  plan?: CompletionPlan
}) {
  const document = fakeTextDocument(input.documentText, input.languageId)
  const position = { line: input.line, character: input.character }
  const lineText = document.lineAt(position.line).text
  const linePrefix = lineText.slice(0, position.character)
  const lineSuffix = lineText.slice(position.character)
  const currentWord = currentWordBeforeCursor(linePrefix)
  const indent = inferCompletionIndent({
    lines: document.lines,
    line: position.line,
    linePrefix,
    fallbackIndentUnit: "    ",
  })
  const plan = input.plan ?? planCompletion({
    languageId: document.languageId,
    linePrefix,
    lineSuffix,
    currentWord: currentWord?.text,
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
    nextNonEmptyLine: nextNonEmptyLineAfter(document.lines, position.line),
    lines: document.lines,
    line: position.line,
    triggerKind: "automatic",
  })
  const result = runCompletionCandidatePipeline({
    rawText: input.rawText,
    textProfile: "generic-chat",
    editInput: {
      languageId: document.languageId,
      linePrefix,
      lineSuffix,
      position,
      indent,
      currentWord: currentWord?.text,
      currentWordRange: currentWord?.range(position.line),
    },
    plan,
    retrievedSnippets: [],
    documentSuffix: documentSuffixAfter(document.lines, position),
  })
  return { plan, result }
}

function commentToCodeInstructionPlan(sourceComment: string): CompletionPlan {
  return {
    kind: "comment-to-code",
    insertMode: "insert-after-line",
    sourceComment,
    replaceCurrentWord: false,
    needsSymbolRetrieval: false,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: true,
    maxTokens: 256,
  }
}

function fakeTextDocument(text: string, languageId: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  return {
    languageId,
    lines,
    lineAt(line: number) {
      return { text: lines[line] ?? "" }
    },
  }
}

function currentWordBeforeCursor(linePrefix: string) {
  const match = /[A-Za-z_][A-Za-z0-9_]*$/.exec(linePrefix)
  if (!match) return undefined
  const text = match[0]
  const startCharacter = linePrefix.length - text.length
  return {
    text,
    range(line: number): CompletionRange {
      return {
        startLine: line,
        startCharacter,
        endLine: line,
        endCharacter: linePrefix.length,
      }
    },
  }
}

function retrieveSymbolCandidate(input: { query: string; relatedPath: string; unitTestTarget?: boolean }) {
  const candidates = searchCodeGraphSymbols({
    index: eprIndex(),
    query: input.query,
    relatedPath: input.relatedPath,
    limit: 5,
  }).map(symbolCandidateFromCodeGraph)
  return resolveSymbols({
    query: input.query,
    relatedPath: input.relatedPath,
    unitTestTarget: input.unitTestTarget,
    candidates,
    limit: 5,
  })[0]
}

function symbolSnippet(symbol: ResolvedSymbolCandidate): RetrievedCompletionSnippet {
  return {
    kind: symbol.kind,
    path: symbol.filePath ?? "",
    line: symbol.line ?? 1,
    text: symbol.signature || symbol.snippet || symbol.name,
    name: symbol.name,
    score: symbol.score,
  }
}

function eprIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "src/epr/epr_ppn_raw.c",
      hash: "epr",
      size: 1,
      text: readFixture("epr_ppn_raw.c"),
    }),
    parseCFile({
      path: "src/epr/epr_ppn_raw_test.c",
      hash: "test",
      size: 1,
      text: readFixture("epr_ppn_raw_test.c"),
    }),
  ]
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  }
}

function readFixture(name: string) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
}

function modelMessage(text: string): CompletionModelMessage {
  return {
    info: { id: "phase10", role: "assistant", providerID: "test", modelID: "test" },
    parts: [{ type: "text", text }],
  }
}

function settings(): RemoteSettings {
  return {
    completion: {
      maxTokens: 128,
      temperature: 0,
      topP: 1,
    },
  } as RemoteSettings
}

function lastIdentifier(input: string) {
  return input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)?.at(-1) ?? ""
}

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function nextNonEmptyLineAfter(lines: string[], line: number) {
  for (let index = line + 1; index < lines.length; index++) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
}

function documentSuffixAfter(lines: string[], position: { line: number; character: number }) {
  const current = lines[position.line] ?? ""
  return [
    current.slice(position.character),
    ...lines.slice(position.line + 1),
  ].join("\n")
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function applySingleLineEdit(lineText: string, range: CompletionRange | undefined, insertText: string) {
  const editRange = range ?? {
    startLine: 0,
    startCharacter: lineText.length,
    endLine: 0,
    endCharacter: lineText.length,
  }
  if (editRange.startLine !== editRange.endLine) return undefined
  const firstLineInsert = insertText.split("\n")[0] ?? ""
  return `${lineText.slice(0, editRange.startCharacter)}${firstLineInsert}${lineText.slice(editRange.endCharacter)}`
}
