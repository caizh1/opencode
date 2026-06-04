import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseCFile } from "../../src/codegraph-c-parser"
import { searchCodeGraphSymbols } from "../../src/codegraph-query"
import type { CodeGraphIndex } from "../../src/codegraph-types"
import { buildCompletionEditResult, buildInlineCompletionEditResult, type CompletionEditRejectReason, type CompletionRange } from "../../src/completion-edit"
import { inferCompletionIndent } from "../../src/completion-indent"
import { postprocessCompletion, type CompletionPostprocessRejectReason } from "../../src/completion-postprocess"
import { planCompletion } from "../../src/completion-plan"
import { resolveSymbols, symbolCandidateFromCodeGraph, type ResolvedSymbolCandidate } from "../../src/completion-symbol"
import { fallbackCompletionText } from "../../src/completion-test-fallback"
import { completionInsertText } from "../../src/completion-text"
import type { CompletionPlanKind } from "../../src/completion-types"
import type { OpenCodeMessage } from "../../src/types"

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "c")
const TARGET_SYMBOL = "epr_ppn_raw_write_with_cb_dfx"
const COMMENT_SYMBOL = "epr_ppn_raw_write_cb_dfx"

describe("phase 1 completion regression eval fixtures", () => {
  test("bare unit-test command resolves the abbreviated symbol and does not surface an echoed prefix", () => {
    const line = "unit test for epr_ppn_raw_wr"
    const snapshot = runCompletionEval({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: line,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
      legacyEchoProbe: true,
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "natural-command",
        insertMode: "replace-whole-line",
        targetSymbol: TARGET_SYMBOL,
      },
      currentWord: "epr_ppn_raw_wr",
      selectedCandidate: TARGET_SYMBOL,
      modelRoute: "instruction",
      rawText: line,
      normalizedText: "",
      finalRange: {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: line.length,
      },
      rejectionReason: undefined,
    })
  })

  test("comment-to-test fixture inserts after the current comment instead of duplicating it", () => {
    const line = `// unit test for ${COMMENT_SYMBOL}()`
    const duplicatedCommentOutput = `${line}\n${line}`
    const snapshot = runCompletionEval({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: duplicatedCommentOutput,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-test",
        insertMode: "insert-after-line",
        targetSymbol: COMMENT_SYMBOL,
      },
      selectedCandidate: COMMENT_SYMBOL,
      modelRoute: "instruction",
      rawText: duplicatedCommentOutput,
      normalizedText: "",
      finalRange: {
        startLine: 0,
        startCharacter: line.length,
        endLine: 0,
        endCharacter: line.length,
      },
      filterText: expect.not.stringContaining(line),
      rejectionReason: undefined,
    })
  })

  test("generic symbol resolver expands epr_ppn_raw_wr without hardcoding the target name", () => {
    const candidates = searchCodeGraphSymbols({
      index: eprIndex(),
      query: "epr_ppn_raw_wr",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
      limit: 5,
    }).map(symbolCandidateFromCodeGraph)
    const [selected] = resolveSymbols({
      query: "epr_ppn_raw_wr",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
      unitTestTarget: true,
      candidates,
      limit: 5,
    })

    expect(symbolResolutionSnapshot(selected)).toEqual({
      query: "epr_ppn_raw_wr",
      selectedCandidate: TARGET_SYMBOL,
      reason: expect.stringContaining("prefix"),
      hardcodedTarget: false,
    })
  })

  test("model output equal to the current prefix is rejected or retried before becoming an inline item", () => {
    const line = "const value = compute"
    const snapshot = runCompletionEval({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: line,
      languageId: "typescript",
      relatedPath: "src/example.ts",
    })

    expect(snapshot).toMatchObject({
      currentWord: "compute",
      rawText: line,
      normalizedText: "",
      finalRange: undefined,
      filterText: undefined,
    })
    expect(["echoed-prefix", "retry-requested"]).toContain(snapshot.rejectionReason)
  })

  test("middle-of-line suffix overlap does not duplicate closing call punctuation", () => {
    const snapshot = runCompletionEval({
      documentText: "    assert_ok();\n",
      line: 0,
      character: "    assert_ok(".length,
      rawModelText: `${TARGET_SYMBOL}());`,
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      normalizedText: `${TARGET_SYMBOL}()`,
      insertText: `${TARGET_SYMBOL}()`,
      finalLine: `    assert_ok(${TARGET_SYMBOL}());`,
      rejectionReason: undefined,
    })
  })

  test("multiline completion indentation follows the current block", () => {
    const documentText = [
      "void phase1_indentation_fixture(int enabled)",
      "{",
      "    if (enabled) {",
      "    }",
      "}",
      "",
    ].join("\n")
    const snapshot = runCompletionEval({
      documentText,
      line: 2,
      character: "    if (enabled) {".length,
      rawModelText: "\nEXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx());\nreturn;",
      languageId: "c",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
    })

    expect(snapshot).toMatchObject({
      insertText: "\n        EXPECT_EQ(0, epr_ppn_raw_write_with_cb_dfx());\n        return;",
      finalRange: {
        startLine: 2,
        startCharacter: "    if (enabled) {".length,
        endLine: 2,
        endCharacter: "    if (enabled) {".length,
      },
      rejectionReason: undefined,
    })
  })
})

type EvalInput = {
  documentText: string
  line: number
  character: number
  rawModelText: string
  languageId: string
  relatedPath: string
  legacyEchoProbe?: boolean
}

type EvalSnapshot = {
  plan: {
    kind: CompletionPlanKind
    insertMode?: string
    targetSymbol?: string
  }
  currentWord?: string
  selectedCandidate?: string
  modelRoute?: string
  rawText: string
  normalizedText: string
  insertText?: string
  finalRange?: CompletionRange
  filterText?: string
  rejectionReason?: CompletionEditRejectReason | CompletionPostprocessRejectReason | "filtered-or-no-visible-text" | "retry-requested"
  finalLine?: string
}

function runCompletionEval(input: EvalInput): EvalSnapshot {
  const document = fakeTextDocument(input.documentText, input.languageId)
  const position = fakePosition(input.line, input.character)
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
  })
  const selectedCandidate = retrieveSymbolCandidate({
    query: plan.targetSymbol ?? currentWord?.text ?? lastIdentifier(linePrefix),
    relatedPath: input.relatedPath,
    unitTestTarget: plan.kind === "comment-to-test" || plan.kind === "natural-command",
  })
  const rawText = completionInsertText(modelMessage(input.rawModelText), "qwen-coder-fim")
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
  const retrievedSnippets = selectedCandidate ? [symbolSnippet(selectedCandidate)] : []
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
  const legacyEchoResult = input.legacyEchoProbe
    ? buildCompletionEditResult({
        text: rawText,
        languageId: document.languageId,
        linePrefix,
        lineSuffix,
        position,
        indent,
        currentWord: currentWord?.text,
        currentWordRange: currentWord?.range(position.line),
        preferCurrentWordReplacement: false,
      })
    : undefined
  const edit = editResult.edit

  return {
    plan: {
      kind: plan.kind,
      insertMode: plan.insertMode,
      targetSymbol: selectedCandidate?.name ?? plan.targetSymbol,
    },
    currentWord: currentWord?.text,
    selectedCandidate: selectedCandidate?.name,
    modelRoute: plan.useInstruction ? "instruction" : plan.useFim ? "fim" : undefined,
    rawText,
    normalizedText,
    insertText: edit?.insertText,
    finalRange: edit?.replaceRange,
    filterText: edit?.filterText,
    rejectionReason: edit ? undefined : postprocessResult.reason ?? legacyEchoResult?.reason ?? editResult.reason ?? (editText ? undefined : "filtered-or-no-visible-text"),
    finalLine: edit ? applySingleLineEdit(lineText, edit.replaceRange, edit.insertText) : undefined,
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

function fakePosition(line: number, character: number) {
  return { line, character }
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

function symbolResolutionSnapshot(selected: ResolvedSymbolCandidate | undefined) {
  return {
    query: "epr_ppn_raw_wr",
    selectedCandidate: selected?.name,
    reason: selected?.reasons.join(","),
    hardcodedTarget: selected?.name === TARGET_SYMBOL && selected.reasons.length === 0,
  }
}

function symbolSnippet(symbol: ResolvedSymbolCandidate) {
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

function modelMessage(text: string): OpenCodeMessage {
  return {
    info: { id: "phase1", role: "assistant" },
    parts: [{ type: "text", text }],
  }
}

function lastIdentifier(input: string) {
  return input.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)?.at(-1) ?? ""
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
