import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseCFile } from "../../src/codegraph-c-parser"
import { searchCodeGraphSymbols } from "../../src/codegraph-query"
import type { CodeGraphIndex } from "../../src/codegraph-types"
import { adaptAndValidateInlineCompletionEdit, buildCompletionEditResult, buildInlineCompletionEditResult, type CompletionEditRejectReason, type CompletionRange } from "../../src/completion-edit"
import { inferCompletionIndent } from "../../src/completion-indent"
import { postprocessCompletion, type CompletionPostprocessRejectReason } from "../../src/completion-postprocess"
import { planCompletion } from "../../src/completion-plan"
import { resolveCompletionPlanAfterSymbolRetrieval, routeCompletionModel, shouldRetryCompletionRejection } from "../../src/completion-router"
import { resolveSymbols, symbolCandidateFromCodeGraph, type ResolvedSymbolCandidate } from "../../src/completion-symbol"
import { fallbackCompletionText } from "../../src/completion-test-fallback"
import { completionInsertText } from "../../src/completion-text"
import type { CompletionPlanKind } from "../../src/completion-types"
import type { ChipMateMessage, RemoteSettings } from "../../src/types"

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

  test("comment identifier prefixes complete to nearby existing functions instead of generated test bodies", () => {
    const line = "// arbitrary words alpha_feature_"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_init(void)",
        "{",
        "}",
        "",
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 8,
      character: line.length,
      rawModelText: "int test_alpha_feature(void) {\n    return 0;\n}",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-symbol-reference",
        insertMode: "replace-current-word",
        targetSymbol: "alpha_feature_finalize",
      },
      currentWord: "alpha_feature_",
      selectedCandidate: "alpha_feature_finalize",
      modelRoute: "deterministic-symbol",
      insertText: "alpha_feature_finalize",
      finalLine: "// arbitrary words alpha_feature_finalize",
      rejectionReason: undefined,
    })
    expect(snapshot.insertText).not.toContain("test_alpha_feature")
  })

  test("unit-test comments first complete plain target-symbol prefixes without generating code", () => {
    const line = "// give me a unit test code for confident"
    const snapshot = runCompletionEval({
      documentText: [
        "static void confidential_guest_support_class_init(void)",
        "{",
        "}",
        "",
        "static void confidential_guest_support_class_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 8,
      character: line.length,
      rawModelText: "static void test_confidential_guest_support_class_init(void)\n{\n}",
      languageId: "c",
      relatedPath: "src/confidential/confidential-guest-support.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-symbol-reference",
        insertMode: "replace-current-word",
        targetSymbol: "confidential_guest_support_class_finalize",
      },
      currentWord: "confident",
      selectedCandidate: "confidential_guest_support_class_finalize",
      modelRoute: "deterministic-symbol",
      insertText: "confidential_guest_support_class_finalize",
      finalLine: "// give me a unit test code for confidential_guest_support_class_finalize",
      rejectionReason: undefined,
    })
    expect(snapshot.insertText).not.toContain("test_confidential")
  })

  test("complete unit-test comment symbols generate code after the comment and strip generated lead comments", () => {
    const line = "// give me a unit test code for confidential_guest_support_class_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void confidential_guest_support_class_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 4,
      character: line.length,
      rawModelText: "// generated note\nstatic void test_confidential_guest_support_class_finalize(void)\n{\n}",
      languageId: "c",
      relatedPath: "src/confidential/confidential-guest-support.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-test",
        insertMode: "insert-after-line",
        targetSymbol: "confidential_guest_support_class_finalize",
      },
      currentWord: "confidential_guest_support_class_finalize",
      selectedCandidate: "confidential_guest_support_class_finalize",
      modelRoute: "instruction",
      normalizedText: "static void test_confidential_guest_support_class_finalize(void)\n{\n}",
      insertText: "\nstatic void test_confidential_guest_support_class_finalize(void)\n{\n}",
      finalLine: line,
      rejectionReason: undefined,
    })
    expect(snapshot.insertText).not.toContain("// generated note")
  })

  test("common test-for comments generate a deterministic C test stub after low-confidence model output", () => {
    const line = "// test for foo"
    const snapshot = runCompletionEval({
      documentText: [
        "int foo(void)",
        "{",
        "    return 0;",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 5,
      character: line.length,
      rawModelText: "}",
      languageId: "c",
      relatedPath: "src/features/foo.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-test",
        insertMode: "insert-after-line",
        targetSymbol: "foo",
      },
      selectedCandidate: "foo",
      modelRoute: "instruction",
      normalizedText: "",
      insertText: "\nstatic void test_foo(void)\n{\n    (void)foo();\n}",
      finalLine: line,
      rejectionReason: undefined,
      retried: false,
    })
  })

  test("the same comment symbol prefix rule works for another unrelated symbol", () => {
    const line = "// 任意中文 storage_"
    const snapshot = runCompletionEval({
      documentText: [
        "static int storage_open(void)",
        "{",
        "    return 0;",
        "}",
        "",
        "static int storage_write_async(void)",
        "{",
        "    return 0;",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 10,
      character: line.length,
      rawModelText: "storage_write_async();",
      languageId: "c",
      relatedPath: "src/storage/storage.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-symbol-reference",
        insertMode: "replace-current-word",
        targetSymbol: "storage_write_async",
      },
      currentWord: "storage_",
      selectedCandidate: "storage_write_async",
      modelRoute: "deterministic-symbol",
      insertText: "storage_write_async",
      finalLine: "// 任意中文 storage_write_async",
      rejectionReason: undefined,
    })
  })

  test("complete real symbols in arbitrary comments switch to instruction insertions", () => {
    const line = "// 任意描述 alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 4,
      character: line.length,
      rawModelText: "alpha_feature_finalize();",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-code",
        insertMode: "insert-after-line",
        targetSymbol: "alpha_feature_finalize",
      },
      currentWord: "alpha_feature_finalize",
      selectedCandidate: "alpha_feature_finalize",
      modelRoute: "instruction",
      insertText: "\nalpha_feature_finalize();",
      finalLine: line,
      rejectionReason: undefined,
    })
  })

  test("comment symbol fallback preserves ordinary comment-to-code generation when no symbol exists", () => {
    const line = "// implement add two numbers"
    const snapshot = runCompletionEval({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: "return a + b;",
      languageId: "typescript",
      relatedPath: "src/features/add.ts",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-code",
        insertMode: "insert-after-line",
        targetSymbol: "numbers",
      },
      currentWord: "numbers",
      selectedCandidate: undefined,
      modelRoute: "instruction",
      insertText: "\nreturn a + b;",
      finalLine: line,
      rejectionReason: undefined,
    })
  })

  test("the blank line after a comment intent continues with instruction code", () => {
    const comment = "// 任意描述 alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        comment,
        "",
      ].join("\n"),
      line: 5,
      character: 0,
      rawModelText: "static void test_alpha_feature_finalize(void)\n{\n}",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "previous-comment-continuation",
        insertMode: "insert-at-cursor",
        targetSymbol: "alpha_feature_finalize",
      },
      selectedCandidate: "alpha_feature_finalize",
      modelRoute: "instruction",
      insertText: "static void test_alpha_feature_finalize(void)\n{\n}",
      finalLine: "static void test_alpha_feature_finalize(void)",
      rejectionReason: undefined,
    })
  })

  test("the line after a comment intent replaces a typed code prefix", () => {
    const comment = "// in order to test alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        comment,
        "stat",
      ].join("\n"),
      line: 5,
      character: "stat".length,
      rawModelText: "static void test_alpha_feature_finalize(void)\n{\n}",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "previous-comment-continuation",
        insertMode: "replace-whole-line",
        targetSymbol: "alpha_feature_finalize",
      },
      currentWord: "stat",
      modelRoute: "instruction",
      insertText: "static void test_alpha_feature_finalize(void)\n{\n}",
      finalRange: {
        startLine: 5,
        startCharacter: 0,
        endLine: 5,
        endCharacter: "stat".length,
      },
      finalLine: "static void test_alpha_feature_finalize(void)",
      rejectionReason: undefined,
    })
  })

  test("the line after a unit-test comment preserves typed code prefixes by shrinking to the current word", () => {
    const comment = "// give me a unit test code for confidential_guest_support_finalize"
    const line = "static void"
    const snapshot = runCompletionEval({
      documentText: [
        "static void confidential_guest_support_finalize(void)",
        "{",
        "}",
        "",
        comment,
        line,
      ].join("\n"),
      line: 5,
      character: line.length,
      rawModelText: "static void test_confidential_guest_support_finalize(void) {\n}",
      languageId: "c",
      relatedPath: "src/confidential/confidential-guest-support.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "previous-comment-continuation",
        insertMode: "replace-whole-line",
        targetSymbol: "confidential_guest_support_finalize",
      },
      currentWord: "void",
      modelRoute: "instruction",
      normalizedText: "static void test_confidential_guest_support_finalize(void) {\n}",
      insertText: "void test_confidential_guest_support_finalize(void) {\n}",
      finalRange: {
        startLine: 5,
        startCharacter: "static ".length,
        endLine: 5,
        endCharacter: line.length,
      },
      finalLine: "static void test_confidential_guest_support_finalize(void) {",
      rejectionReason: undefined,
    })
    expect(snapshot.insertText?.split("\n")[0]).toBe("void test_confidential_guest_support_finalize(void) {")
    expect(snapshot.insertText?.split("\n")[0]).not.toBe("test_confidential_guest_support_finalize(void) {")
  })

  test("the line after a comment intent rejects overtyped prefixes that cannot be safely adapted", () => {
    const comment = "// in order to test alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        comment,
        "stats",
      ].join("\n"),
      line: 5,
      character: "stats".length,
      rawModelText: "static void test_alpha_feature_finalize(void)\n{\n}",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "previous-comment-continuation",
        insertMode: "replace-whole-line",
      },
      currentWord: "stats",
      insertText: undefined,
      finalRange: undefined,
      rejectionReason: "rangeText-not-prefix-of-filterText",
    })
  })

  test("low-confidence comment code output retries and accepts meaningful retry code", () => {
    const line = "// 任意描述 alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 4,
      character: line.length,
      rawModelText: "}",
      retryRawModelText: "alpha_feature_finalize();",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-code",
        insertMode: "insert-after-line",
        targetSymbol: "alpha_feature_finalize",
      },
      modelRoute: "instruction",
      retried: true,
      insertText: "\nalpha_feature_finalize();",
      rejectionReason: undefined,
    })
  })

  test("low-confidence comment code retry remains silent when retry is also structural-only", () => {
    const line = "// arbitrary words alpha_feature_finalize"
    const snapshot = runCompletionEval({
      documentText: [
        "static void alpha_feature_finalize(void)",
        "{",
        "}",
        "",
        line,
        "",
      ].join("\n"),
      line: 4,
      character: line.length,
      rawModelText: "}",
      retryRawModelText: "};",
      languageId: "c",
      relatedPath: "src/features/alpha.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-to-code",
        insertMode: "insert-after-line",
        targetSymbol: "alpha_feature_finalize",
      },
      modelRoute: "instruction",
      retried: true,
      insertText: undefined,
      rejectionReason: "low-confidence-output",
    })
  })

  test("unresolved comment symbols stay silent instead of calling the model", () => {
    const line = "// any words missing_project_symbol_"
    const snapshot = runCompletionEval({
      documentText: `${line}\n`,
      line: 0,
      character: line.length,
      rawModelText: "missing_project_symbol_fake();",
      languageId: "c",
      relatedPath: "src/features/missing.c",
    })

    expect(snapshot).toMatchObject({
      plan: {
        kind: "comment-symbol-reference",
        insertMode: "replace-current-word",
        targetSymbol: "missing_project_symbol_",
      },
      currentWord: "missing_project_symbol_",
      selectedCandidate: undefined,
      modelRoute: "none",
      insertText: undefined,
    })
  })
})

type EvalInput = {
  documentText: string
  line: number
  character: number
  rawModelText: string
  retryRawModelText?: string
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
  retried?: boolean
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
    previousNonEmptyLine: previousNonEmptyLineBefore(document.lines, position.line),
  })
  const selectedCandidate = retrieveSymbolCandidate({
    query: plan.targetSymbol ?? currentWord?.text ?? lastIdentifier(linePrefix),
    relatedPath: input.relatedPath,
    cursorLine: input.line + 1,
    preferNearbyAbove: plan.kind === "comment-symbol-reference",
    unitTestTarget: plan.needsTestRetrieval,
    documentText: input.documentText,
  })
  const retrievedSnippets = selectedCandidate ? [symbolSnippet(selectedCandidate)] : []
  const effectivePlan = resolveCompletionPlanAfterSymbolRetrieval(plan, retrievedSnippets)
  const route = routeCompletionModel({
    plan: effectivePlan,
    settings: evalSettings(),
    retrievedSnippets,
  })
  let attempt = buildEvalAttempt(input.rawModelText)
  let retried = false
  const initialReason = rejectionReasonForAttempt(attempt)
  if (!attempt.edit && input.retryRawModelText && route.kind === "model" && initialReason && shouldRetryCompletionRejection({
    reason: initialReason,
    plan: effectivePlan,
    textProfile: route.textProfile,
  })) {
    attempt = buildEvalAttempt(input.retryRawModelText)
    retried = true
  }

  return {
    plan: {
      kind: effectivePlan.kind,
      insertMode: effectivePlan.insertMode,
      targetSymbol: selectedCandidate?.name ?? effectivePlan.targetSymbol,
    },
    currentWord: currentWord?.text,
    selectedCandidate: selectedCandidate?.name,
    modelRoute: route.kind === "deterministic-symbol"
      ? "deterministic-symbol"
      : route.kind === "none"
        ? "none"
        : route.promptKind === "instruction" ? "instruction" : "fim",
    rawText: attempt.rawText,
    normalizedText: attempt.normalizedText,
    insertText: attempt.edit?.insertText,
    finalRange: attempt.edit?.replaceRange,
    filterText: attempt.edit?.filterText,
    rejectionReason: attempt.edit ? undefined : rejectionReasonForAttempt(attempt),
    finalLine: attempt.edit ? applySingleLineEdit(lineText, attempt.edit.replaceRange, attempt.edit.insertText) : undefined,
    retried,
  }

  function buildEvalAttempt(rawModelText: string) {
    const rawText = route.kind === "model"
      ? completionInsertText(modelMessage(rawModelText), route.textProfile)
      : ""
    const postprocessResult = rawText
      ? postprocessCompletion({
          rawText,
          linePrefix,
          lineSuffix,
          currentWord: currentWord?.text,
          fullCurrentLine: lineText,
          languageId: document.languageId,
          plan: effectivePlan,
          indent: {
            currentIndent: lineIndent(linePrefix),
            targetIndent: indent.targetIndent,
            indentUnit: indent.indentUnit,
          },
        })
      : {
          text: "",
          rejected: true,
          reason: "empty-output" as const,
        }
    const normalizedText = postprocessResult.text
    const editText = route.kind === "deterministic-symbol"
      ? route.text
      : route.kind === "none"
        ? ""
        : normalizedText || fallbackCompletionText({
            languageId: document.languageId,
            plan: effectivePlan,
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
      plan: effectivePlan,
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
          plan: effectivePlan,
        })
      : undefined
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
    return {
      rawText,
      postprocessResult,
      normalizedText,
      editText,
      editResult,
      adaptedResult,
      legacyEchoResult,
      edit: adaptedResult?.status === "ok" ? adaptedResult.edit : undefined,
    }
  }

  function rejectionReasonForAttempt(attempt: ReturnType<typeof buildEvalAttempt>) {
    return attempt.postprocessResult.reason ?? attempt.legacyEchoResult?.reason ?? attempt.adaptedResult?.reason ?? attempt.editResult.reason ?? (attempt.editText ? undefined : "filtered-or-no-visible-text")
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

function previousNonEmptyLineBefore(lines: string[], line: number) {
  for (let index = line - 1; index >= 0; index--) {
    const text = lines[index]
    if (text?.trim()) return text
  }
  return undefined
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

function retrieveSymbolCandidate(input: {
  query: string
  relatedPath: string
  cursorLine: number
  preferNearbyAbove?: boolean
  unitTestTarget?: boolean
  documentText: string
}) {
  const candidates = searchCodeGraphSymbols({
    index: completionIndex(input.relatedPath, input.documentText),
    query: input.query,
    relatedPath: input.relatedPath,
    limit: input.preferNearbyAbove ? 50 : 5,
  }).map(symbolCandidateFromCodeGraph)
  return resolveSymbols({
    query: input.query,
    relatedPath: input.relatedPath,
    cursorLine: input.cursorLine,
    preferNearbyAbove: input.preferNearbyAbove,
    unitTestTarget: input.unitTestTarget,
    candidates,
    limit: input.preferNearbyAbove ? 50 : 5,
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

function completionIndex(relatedPath: string, documentText: string): CodeGraphIndex {
  if (relatedPath.startsWith("src/epr/")) return eprIndex()
  const file = parseCFile({
    path: relatedPath,
    hash: "current",
    size: documentText.length,
    text: documentText,
  })
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: {
      [file.path]: file,
    },
  }
}

function evalSettings(): RemoteSettings {
  return {
    serverUrl: "http://localhost:4096",
    username: "chipmate",
    defaultModel: "",
    defaultAgent: "",
    localOnlyAgent: "chipmate-local",
    context: {
      maxFileBytes: 16000,
      maxFiles: 8,
      includeDiagnostics: true,
      includeGitDiff: false,
      localOnlyMode: true,
      strictLocalOnlyAgent: true,
    },
    permissions: {
      mode: "ask",
    },
    tools: {
      enabled: false,
    },
    skills: {
      enabled: [],
    },
    mcp: {
      enabled: false,
    },
    completion: {
      enabled: true,
      provider: "openai-compatible" as const,
      profile: "generic-chat" as const,
      apiBaseUrl: "http://localhost:8000/v1",
      model: "qwen",
      maxTokens: 128,
      temperature: 0,
      topP: 1,
      debounceMs: 350,
      logLevel: "info" as const,
    },
    codeGraph: {
      enabled: false,
      promptOnWorkspaceOpen: true,
      analysisMode: "auto",
      maxFiles: 50000,
      maxContextBytes: 24000,
      maxEvidenceBytes: 60000,
      maxGraphDepth: 2,
      maxFanout: 40,
      maxDeepFiles: 24,
      maxStateTransitions: 120,
      watcherRescanThreshold: 750,
      workerConcurrency: 4,
      queryCacheSize: 80,
      memoryLimitMb: 4096,
      compileCommandsPath: "",
      clangdPath: "",
      scipClangPath: "",
      excludeGlobs: [],
    },
    analysis: {
      bridgeEnabled: true,
      maxEvidenceItems: 40,
      maxEvidenceBytes: 60000,
      maxFileSliceBytes: 16000,
      maxGraphEdges: 120,
      maxPaths: 10,
    },
    rag: {
      embedding: {
        enabled: false,
        endpoint: "",
        model: "",
        batchSize: 128,
        maxTokensPerRequest: 65536,
        concurrentRequests: 3,
        maxInFlightTokens: 180000,
        encodingFormat: "float",
        checkpointMode: "interval",
        checkpointChunkInterval: 8192,
        checkpointIntervalMs: 120000,
        timeoutMs: 30000,
        requestDelayMs: 0,
        maxRequestsPerRun: 100,
        maxRetries: 3,
        retryBackoffMs: 2000,
        resumeAutomatically: true,
        resumeDelayMs: 60000,
      },
      rerank: {
        enabled: false,
        endpoint: "",
        model: "",
      },
      allowedHosts: [],
      vectorTopK: 24,
      rerankTopK: 16,
    },
  }
}

function readFixture(name: string) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
}

function modelMessage(text: string): ChipMateMessage {
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
