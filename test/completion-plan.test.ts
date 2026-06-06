import { describe, expect, test } from "bun:test"
import { planCompletion } from "../src/completion-plan"

describe("completion planner", () => {
  test("routes bare unit-test prompts as natural commands that replace the whole line", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "unit test for epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "natural-command",
      insertMode: "replace-whole-line",
      targetSymbol: "epr_ppn_raw_wr",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useFim: false,
      useInstruction: true,
      maxTokens: 768,
    })
  })

  test("keeps comment unit-test prompts as insertions after the comment", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
      lineSuffix: "",
    })).toMatchObject({
      kind: "comment-to-test",
      insertMode: "insert-after-line",
      targetSymbol: "epr_ppn_raw_write_cb_dfx",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useFim: false,
      useInstruction: true,
    })
  })

  test("recognizes common test-for comment prompts as test generation", () => {
    for (const linePrefix of [
      "// test for confidential_guest_support_finalize",
      "// write test for confidential_guest_support_finalize",
      "// tests for confidential_guest_support_finalize",
    ]) {
      expect(planCompletion({
        languageId: "c",
        linePrefix,
        lineSuffix: "",
      })).toMatchObject({
        kind: "comment-to-test",
        insertMode: "insert-after-line",
        targetSymbol: "confidential_guest_support_finalize",
        needsSymbolRetrieval: true,
        needsTestRetrieval: true,
        useInstruction: true,
      })
    }
  })

  test("recognizes common natural test-for prompts as line replacements", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "write test for confidential_guest_support_finalize",
      lineSuffix: "",
    })).toMatchObject({
      kind: "natural-command",
      insertMode: "replace-whole-line",
      targetSymbol: "confidential_guest_support_finalize",
      needsSymbolRetrieval: true,
      needsTestRetrieval: true,
      useInstruction: true,
    })
  })

  test("routes identifier continuations through symbol completion", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
    })).toMatchObject({
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: "epr_ppn_raw_wr",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
      maxTokens: 48,
    })
  })

  test("keeps ordinary code on the Qwen FIM path", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "const value = ",
      lineSuffix: "",
    })).toMatchObject({
      kind: "ordinary-code",
      insertMode: "insert-at-cursor",
      replaceCurrentWord: false,
      needsSymbolRetrieval: false,
      needsTestRetrieval: false,
      useFim: true,
      useInstruction: false,
    })
  })

  test("keeps short identifiers when there is clear expression context", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "  const message = na",
      lineSuffix: "",
      currentWord: "na",
    })).toMatchObject({
      kind: "ordinary-code",
      useFim: true,
      useInstruction: false,
    })
  })

  test("disables bare low-signal identifiers instead of calling FIM", () => {
    for (const linePrefix of ["t", "re"]) {
      expect(planCompletion({
        languageId: "typescript",
        linePrefix,
        lineSuffix: "",
        currentWord: linePrefix,
      })).toMatchObject({
        kind: "disabled",
        useFim: false,
        useInstruction: false,
      })
    }
  })

  test("manual triggers do not disable low-signal input", () => {
    for (const linePrefix of ["t", "re", ";"]) {
      expect(planCompletion({
        languageId: "typescript",
        linePrefix,
        lineSuffix: "",
        currentWord: /^[A-Za-z_]/.test(linePrefix) ? linePrefix : undefined,
        triggerKind: "manual",
      })).toMatchObject({
        kind: "ordinary-code",
        useFim: true,
        useInstruction: false,
      })
    }
  })

  test("allows short C/C++ identifier prefixes to reach FIM", () => {
    for (const currentWord of ["u", "io", "rb", "sq", "cq", "hw", "req", "cmd"]) {
      expect(planCompletion({
        languageId: "c",
        linePrefix: `    ${currentWord}`,
        lineSuffix: "",
        currentWord,
        triggerKind: "automatic",
      })).toMatchObject({
        kind: "ordinary-code",
        useFim: true,
        useInstruction: false,
        cIntent: "symbol-prefix",
      })
    }
  })

  test("classifies common C/C++ inline intents without project-specific names", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    req->",
      lineSuffix: "",
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      cIntent: "member-access",
      needsSymbolRetrieval: true,
    })

    expect(planCompletion({
      languageId: "c",
      linePrefix: "    device_start(",
      lineSuffix: ");",
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      cIntent: "call-args",
      needsSymbolRetrieval: true,
    })

    expect(planCompletion({
      languageId: "c",
      linePrefix: "        .status = ",
      lineSuffix: ",",
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      cIntent: "initializer",
      needsSymbolRetrieval: true,
    })

    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ret = ",
      lineSuffix: "",
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      cIntent: "assignment-rhs",
      needsSymbolRetrieval: true,
    })
  })

  test("classifies embedded C/C++ condition, error path, and MMIO intents structurally", () => {
    for (const linePrefix of ["    if (", "    while ("]) {
      expect(planCompletion({
        languageId: "c",
        linePrefix,
        lineSuffix: ") {",
        triggerKind: "automatic",
      })).toMatchObject({
        kind: "ordinary-code",
        cIntent: "condition",
        needsSymbolRetrieval: true,
      })
    }

    expect(planCompletion({
      languageId: "c",
      linePrefix: "        goto ",
      lineSuffix: ";",
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      cIntent: "error-path",
      needsSymbolRetrieval: true,
    })

    const lines = [
      "int driver_probe(struct driver *drv)",
      "{",
      "    int ret;",
      "    if (ret) {",
      "        ",
      "    }",
      "out_unlock:",
      "    driver_unlock(drv);",
      "    return ret;",
      "}",
    ]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "        ",
      lineSuffix: "",
      previousNonEmptyLine: lines[3],
      nextNonEmptyLine: lines[5],
      lines,
      line: 4,
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "body-continuation",
      cIntent: "error-path",
      needsSymbolRetrieval: true,
    })

    for (const linePrefix of ["    writel(", "    FIELD_PREP(", "    ctrl = DEVICE_STATUS_REG | "]) {
      expect(planCompletion({
        languageId: "c",
        linePrefix,
        lineSuffix: ");",
        triggerKind: "automatic",
      })).toMatchObject({
        kind: "ordinary-code",
        cIntent: "mmio-register",
        needsSymbolRetrieval: true,
      })
    }
  })

  test("does not attach C/C++-specific intents to non-C/C++ languages", () => {
    const plan = planCompletion({
      languageId: "typescript",
      linePrefix: "    if (",
      lineSuffix: ") {",
      triggerKind: "automatic",
    })
    expect(plan).toMatchObject({
      kind: "ordinary-code",
      needsSymbolRetrieval: false,
    })
    expect(plan).not.toHaveProperty("cIntent")
  })

  test("disables punctuation-only requests instead of calling FIM", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: ";",
      lineSuffix: "",
    })).toMatchObject({
      kind: "disabled",
      useFim: false,
      useInstruction: false,
    })
  })

  test("disables requests inside an active string literal", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "const title = \"hello ",
      lineSuffix: "\";",
    })).toMatchObject({
      kind: "disabled",
      useFim: false,
      useInstruction: false,
    })
  })

  test("routes non-test comment prompts as comment-to-code instructions", () => {
    expect(planCompletion({
      languageId: "typescript",
      linePrefix: "// implement add two numbers",
      lineSuffix: "",
      currentWord: "numbers",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "numbers",
      symbolFallbackKind: "comment-to-code",
      replaceCurrentWord: true,
      useFim: false,
      useInstruction: false,
    })
  })

  test("carries source comments for C/C++ comment-to-code generation", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// Add project-style error cleanup before success return.",
      lineSuffix: "",
    })).toMatchObject({
      kind: "comment-to-code",
      sourceComment: "// Add project-style error cleanup before success return.",
      useFim: false,
      useInstruction: true,
    })

    expect(planCompletion({
      languageId: "c",
      linePrefix: "/* Add project-style error cleanup before success return. */",
      lineSuffix: "",
    })).toMatchObject({
      kind: "comment-to-code",
      sourceComment: "/* Add project-style error cleanup before success return. */",
      useFim: false,
      useInstruction: true,
    })
  })

  test("tries plain identifier prefixes inside unit-test comments before generating code", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// give me a unit test code for confident",
      lineSuffix: "",
      currentWord: "confident",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "confident",
      symbolFallbackKind: "comment-to-test",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
    })
  })

  test("tries plain identifier prefixes inside common test-for comments before generating code", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// test for confident",
      lineSuffix: "",
      currentWord: "confident",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "confident",
      symbolFallbackKind: "comment-to-test",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useInstruction: false,
    })
  })

  test("routes identifier prefixes inside comments as deterministic symbol references", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "// arbitrary words alpha_feature_",
      lineSuffix: "",
      currentWord: "alpha_feature_",
    })).toMatchObject({
      kind: "comment-symbol-reference",
      insertMode: "replace-current-word",
      targetSymbol: "alpha_feature_",
      replaceCurrentWord: true,
      needsSymbolRetrieval: true,
      needsTestRetrieval: false,
      useFim: false,
      useInstruction: false,
    })
  })

  test("routes the line after a comment intent to instruction continuation", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "// 任意描述 alpha_feature_finalize",
      linePrefix: "",
      lineSuffix: "",
    })).toMatchObject({
      kind: "previous-comment-continuation",
      insertMode: "insert-at-cursor",
      targetSymbol: "alpha_feature_finalize",
      sourceComment: "// 任意描述 alpha_feature_finalize",
      replaceCurrentWord: false,
      needsSymbolRetrieval: true,
      useFim: false,
      useInstruction: true,
    })
  })

  test("keeps previous comment continuation ahead of current-word symbol completion", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "// in order to test alpha_feature_finalize",
      linePrefix: "stat",
      lineSuffix: "",
      currentWord: "stat",
    })).toMatchObject({
      kind: "previous-comment-continuation",
      insertMode: "replace-whole-line",
      targetSymbol: "alpha_feature_finalize",
      needsTestRetrieval: true,
      useInstruction: true,
    })
  })

  test("does not treat ordinary identifier prefixes as previous comment continuations", () => {
    expect(planCompletion({
      languageId: "c",
      previousNonEmptyLine: "static void unrelated(void)",
      linePrefix: "stat",
      lineSuffix: "",
      currentWord: "stat",
    })).toMatchObject({
      kind: "symbol-completion",
      insertMode: "replace-current-word",
      targetSymbol: "stat",
      useInstruction: false,
    })
  })

  test("disables empty column-zero requests", () => {
    expect(planCompletion({
      languageId: "c",
      linePrefix: "",
      lineSuffix: "",
    })).toMatchObject({
      kind: "disabled",
      insertMode: "insert-at-cursor",
      useFim: false,
      useInstruction: false,
    })
  })

  test("routes C/C++ top-level declaration gaps to FIM", () => {
    const lines = ["#include <stdint.h>", "", "typedef struct device device_t;"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "",
      lineSuffix: "",
      previousNonEmptyLine: lines[0],
      nextNonEmptyLine: lines[2],
      lines,
      line: 1,
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "top-level-declaration",
      insertMode: "insert-at-cursor",
      cIntent: "top-level-declaration",
      useFim: true,
      useInstruction: false,
    })
  })

  test("routes blank lines inside C function bodies as body continuations", () => {
    const lines = [
      "hal_status_t enable_uart(void)",
      "{",
      "    uint32_t flags = UART_CTRL_ENABLE;",
      "    ",
      "    return HAL_OK;",
      "}",
    ]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: lines[2],
      nextNonEmptyLine: lines[4],
      lines,
      line: 3,
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "body-continuation",
      insertMode: "insert-at-cursor",
      useFim: true,
      useInstruction: false,
      maxTokens: 96,
    })
  })

  test("uses a larger body continuation budget for manual triggers", () => {
    const lines = ["void task(void)", "{", "    while (running) {", "    ", "    }", "}"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: lines[2],
      nextNonEmptyLine: lines[4],
      lines,
      line: 3,
      triggerKind: "manual",
    })).toMatchObject({
      kind: "body-continuation",
      maxTokens: 128,
    })
  })

  test("routes blank lines inside C aggregates and switch cases to FIM", () => {
    const aggregate = ["typedef struct {", "    ", "    uint32_t value;", "} cfg_t;"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: aggregate[0],
      nextNonEmptyLine: aggregate[2],
      lines: aggregate,
      line: 1,
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "ordinary-code",
      useFim: true,
      useInstruction: false,
    })

    const switchCase = ["void f(int state)", "{", "    switch (state) {", "    case 1:", "        ", "        break;", "    }", "}"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "        ",
      lineSuffix: "",
      previousNonEmptyLine: switchCase[3],
      nextNonEmptyLine: switchCase[5],
      lines: switchCase,
      line: 4,
      triggerKind: "automatic",
    })).toMatchObject({
      kind: "body-continuation",
      cIntent: "case-body",
      useFim: true,
      useInstruction: false,
    })
  })

  test("does not route comment or string blank lines as C/C++ completions", () => {
    const topLevel = ["int a;", "", "int b;"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "",
      lineSuffix: "",
      previousNonEmptyLine: topLevel[0],
      nextNonEmptyLine: topLevel[2],
      lines: topLevel,
      line: 1,
    })).toMatchObject({ kind: "top-level-declaration" })

    const comment = ["void f(void)", "{", "    /*", "    ", "     */", "}"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: comment[2],
      nextNonEmptyLine: comment[4],
      lines: comment,
      line: 3,
    })).toMatchObject({ kind: "disabled" })

    expect(planCompletion({
      languageId: "c",
      linePrefix: "     disabled",
      lineSuffix: "",
      currentWord: "disabled",
      previousNonEmptyLine: comment[2],
      nextNonEmptyLine: comment[4],
      lines: comment,
      line: 3,
      triggerKind: "manual",
    })).toMatchObject({ kind: "disabled" })

    const string = ["void f(void)", "{", "    const char *s = \"", "    ", "    \";", "}"]
    expect(planCompletion({
      languageId: "c",
      linePrefix: "    ",
      lineSuffix: "",
      previousNonEmptyLine: string[2],
      nextNonEmptyLine: string[4],
      lines: string,
      line: 3,
    })).toMatchObject({ kind: "disabled" })
  })
})
