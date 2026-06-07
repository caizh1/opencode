import { describe, expect, test } from "bun:test"
import { postprocessCompletion, trimCompletionForCIntent } from "../src/completion-postprocess"
import { planCompletion } from "../src/completion-plan"

describe("completion postprocessor", () => {
  test("strips markdown fences", () => {
    expect(postprocessCompletion({
      rawText: "```ts\nreturn value;\n```",
      linePrefix: "  ",
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "return value;",
    })
  })

  test("unwraps C inline-code backticks when the whole completion is wrapped", () => {
    expect(postprocessCompletion({
      rawText: "`flags & BIT(0)`",
      linePrefix: "    if (",
      lineSuffix: ") {",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent("    ", "        "),
    })).toEqual({
      text: "flags & BIT(0)",
    })
  })

  test("does not unwrap language backticks outside C-style completions", () => {
    expect(postprocessCompletion({
      rawText: "`template ${value}`",
      linePrefix: "const label = ",
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "`template ${value}`",
    })
  })

  test("strips explanatory lead-ins", () => {
    expect(postprocessCompletion({
      rawText: "Here is the completion:\nreturn value;",
      linePrefix: "  ",
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "return value;",
    })
  })

  test("rejects explanation-only output", () => {
    expect(postprocessCompletion({
      rawText: "This completion would add a unit test for the target function.",
      linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
      lineSuffix: "",
      languageId: "c",
      plan: commentToTestPlan(),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "explanation-only",
    })
  })

  test("rejects output that only echoes the current prefix", () => {
    const linePrefix = "const value = compute"
    expect(postprocessCompletion({
      rawText: linePrefix,
      linePrefix,
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "echoed-prefix",
    })
  })

  test("replace-whole-line preserves a full line-prefix candidate", () => {
    const rawText = "static void test_confidential_guest_support_finalize(void) {\n}"
    expect(postprocessCompletion({
      rawText,
      linePrefix: "static void",
      lineSuffix: "",
      currentWord: "void",
      languageId: "c",
      plan: postprocessPlan({
        kind: "previous-comment-continuation",
        insertMode: "replace-whole-line",
        replaceCurrentWord: true,
      }),
      indent: indent(),
    })).toEqual({
      text: rawText,
    })
  })

  test("replace-whole-line still rejects exact current-prefix echoes", () => {
    expect(postprocessCompletion({
      rawText: "static void",
      linePrefix: "static void",
      lineSuffix: "",
      currentWord: "void",
      languageId: "c",
      plan: postprocessPlan({
        kind: "previous-comment-continuation",
        insertMode: "replace-whole-line",
        replaceCurrentWord: true,
      }),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "echoed-prefix",
    })
  })

  test("insert-at-cursor converts full prefix candidates to deltas without dropping needed spaces", () => {
    expect(postprocessCompletion({
      rawText: "static void test_confidential_guest_support_finalize(void)",
      linePrefix: "static void",
      lineSuffix: "",
      currentWord: "void",
      languageId: "c",
      plan: postprocessPlan({
        insertMode: "insert-at-cursor",
      }),
      indent: indent(),
    })).toEqual({
      text: " test_confidential_guest_support_finalize(void)",
    })
  })

  test("insert-at-cursor keeps dotted prefix delta normalization", () => {
    expect(postprocessCompletion({
      rawText: "console.log",
      linePrefix: "console.",
      lineSuffix: "",
      languageId: "typescript",
      plan: postprocessPlan({
        insertMode: "insert-at-cursor",
      }),
      indent: indent(),
    })).toEqual({
      text: "log",
    })
  })

  test("replace-current-word preserves full line-prefix candidates for the edit builder", () => {
    expect(postprocessCompletion({
      rawText: "static void test_confidential_guest_support_finalize(void)",
      linePrefix: "static void",
      lineSuffix: "",
      currentWord: "void",
      languageId: "c",
      plan: postprocessPlan({
        insertMode: "replace-current-word",
        replaceCurrentWord: true,
      }),
      indent: indent(),
    })).toEqual({
      text: "static void test_confidential_guest_support_finalize(void)",
    })
  })

  test("strips repeated comment prompts and keeps generated code", () => {
    const linePrefix = "// unit test for epr_ppn_raw_write_cb_dfx()"
    expect(postprocessCompletion({
      rawText: `${linePrefix}\nTEST(EprPpnRaw, WriteCbDfx) {\n}`,
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToTestPlan(),
      indent: indent(),
    })).toEqual({
      text: "TEST(EprPpnRaw, WriteCbDfx) {\n}",
    })
  })

  test("normalizes C embedded symbol-prefix full candidates to cursor suffixes", () => {
    expect(postprocessCompletion({
      rawText: "epr_ppn_raw_write_with_cb_dfx",
      linePrefix: "    epr_ppn_raw_wr",
      lineSuffix: "",
      currentWord: "epr_ppn_raw_wr",
      languageId: "c",
      plan: planCompletion({
        languageId: "c",
        linePrefix: "    epr_ppn_raw_wr",
        lineSuffix: "",
        currentWord: "epr_ppn_raw_wr",
      }),
      indent: indent("    ", "    "),
    })).toMatchObject({
      text: "ite_with_cb_dfx",
    })
  })

  test("rejects output that only repeats the current comment prompt", () => {
    const linePrefix = "// unit test for epr_ppn_raw_write_cb_dfx()"
    expect(postprocessCompletion({
      rawText: `${linePrefix}\n${linePrefix}`,
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToTestPlan(),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "repeated-comment",
    })
  })

  test("strips middle-of-line suffix overlap", () => {
    expect(postprocessCompletion({
      rawText: "epr_ppn_raw_write_with_cb_dfx());",
      linePrefix: "    assert_ok(",
      lineSuffix: ");",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "epr_ppn_raw_write_with_cb_dfx()",
    })
  })

  test("keeps macro call closing parens when suffix starts with a block condition close", () => {
    expect(postprocessCompletion({
      rawText: "flags & BIT(0)",
      linePrefix: "    if (",
      lineSuffix: ") {",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent("    ", "        "),
    })).toEqual({
      text: "flags & BIT(0)",
    })
  })

  test("rejects middle-of-line output that starts by echoing the suffix", () => {
    expect(postprocessCompletion({
      rawText: ";\n}",
      linePrefix: "    return ",
      lineSuffix: ";",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent("    ", "    "),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "suffix-duplicated-output",
    })
  })

  test("strips trailing semicolon that would duplicate the current suffix", () => {
    expect(postprocessCompletion({
      rawText: "ret + 10;",
      linePrefix: "    return ",
      lineSuffix: ";",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent("    ", "    "),
    })).toEqual({
      text: "ret + 10",
    })
  })

  test("normalizes common indentation in multiline output", () => {
    expect(postprocessCompletion({
      rawText: "        EXPECT_EQ(0, call());\n        return;",
      linePrefix: "    if (enabled) {",
      lineSuffix: "",
      languageId: "c",
      plan: ordinaryPlan(),
      indent: indent("    ", "        "),
    })).toEqual({
      text: "EXPECT_EQ(0, call());\nreturn;",
    })
  })

  test("rejects empty output", () => {
    expect(postprocessCompletion({
      rawText: "```ts\n```",
      linePrefix: "const value = ",
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "empty-output",
    })
  })

  test("rejects low-confidence placeholders", () => {
    expect(postprocessCompletion({
      rawText: "TODO",
      linePrefix: "const value = ",
      lineSuffix: "",
      languageId: "typescript",
      plan: ordinaryPlan(),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "low-confidence-output",
    })
  })

  test("rejects structural-only outputs for comment code generation", () => {
    const linePrefix = "// arbitrary words target_symbol"
    for (const rawText of ["}", ";", "{}", "};"]) {
      expect(postprocessCompletion({
        rawText,
        linePrefix,
        lineSuffix: "",
        languageId: "c",
        plan: commentToCodePlan(linePrefix),
        indent: indent(),
      })).toEqual({
        text: "",
        rejected: true,
        reason: "low-confidence-output",
      })
    }
  })

  test("keeps ordinary code continuations even when they are small structural fragments", () => {
    expect(postprocessCompletion({
      rawText: "}",
      linePrefix: "    if (enabled) {",
      lineSuffix: "",
      languageId: "c",
      plan: postprocessPlan({
        insertMode: "insert-at-cursor",
      }),
      indent: indent("    ", "        "),
    })).toEqual({
      text: "}",
    })
  })

  test("rejects generated comment placeholders followed only by structure", () => {
    const linePrefix = "// arbitrary words target_symbol"
    expect(postprocessCompletion({
      rawText: "// generated note\n}",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "low-confidence-output",
    })
  })

  test("rejects pure generated comments for instruction completions", () => {
    const linePrefix = "// arbitrary words target_symbol"
    expect(postprocessCompletion({
      rawText: "// generated note",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "",
      rejected: true,
      reason: "low-confidence-output",
    })
  })

  test("strips generated leading comments when real code follows", () => {
    const linePrefix = "// arbitrary words target_symbol"
    expect(postprocessCompletion({
      rawText: "// generated note\nstatic void test_target_symbol(void)\n{\n}",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "static void test_target_symbol(void)\n{\n}",
    })

    expect(postprocessCompletion({
      rawText: "// generated note\nObject *test_obj = object_new();",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "Object *test_obj = object_new();",
    })
  })

  test("keeps meaningful comment code generation outputs", () => {
    const linePrefix = "// arbitrary words target_symbol"
    expect(postprocessCompletion({
      rawText: "target_symbol();",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "target_symbol();",
    })
    expect(postprocessCompletion({
      rawText: "return 0;",
      linePrefix,
      lineSuffix: "",
      languageId: "c",
      plan: commentToCodePlan(linePrefix),
      indent: indent(),
    })).toEqual({
      text: "return 0;",
    })
  })

  test("trims member-access completions to field-shaped text", () => {
    expect(trimCompletionForCIntent({
      text: "status;\nif (ret) {\n    goto out;\n}",
      cIntent: "member-access",
      linePrefix: "    req->",
      lineSuffix: "",
      languageId: "c",
    })).toBe("status")
  })

  test("trims call-argument completions before closing call suffix", () => {
    expect(trimCompletionForCIntent({
      text: "dev, flags);\nreturn ret;",
      cIntent: "call-args",
      linePrefix: "    ret = driver_start(",
      lineSuffix: ");",
      languageId: "c",
    })).toBe("dev, flags")
  })

  test("trims initializer completions before aggregate close", () => {
    expect(trimCompletionForCIntent({
      text: ".complete = driver_complete,\n};\n",
      cIntent: "initializer",
      linePrefix: "    ",
      lineSuffix: "};",
      languageId: "c",
    })).toBe(".complete = driver_complete,")
  })

  test("trims condition completions to condition expressions", () => {
    expect(trimCompletionForCIntent({
      text: "ret < 0) {\n    goto out;",
      cIntent: "condition",
      linePrefix: "    if (",
      lineSuffix: ") {",
      languageId: "c",
    })).toBe("ret < 0")
  })

  test("keeps concise error-path statements while trimming excess automatic output", () => {
    expect(trimCompletionForCIntent({
      text: "goto out_unlock;\nreturn 0;\nret = 1;\nret = 2;\nret = 3;",
      cIntent: "error-path",
      linePrefix: "        ",
      lineSuffix: "",
      languageId: "c",
    })).toBe("goto out_unlock;\nreturn 0;")
  })
})

function ordinaryPlan() {
  return planCompletion({
    languageId: "typescript",
    linePrefix: "const value = ",
    lineSuffix: "",
  })
}

function commentToTestPlan() {
  return planCompletion({
    languageId: "c",
    linePrefix: "// unit test for epr_ppn_raw_write_cb_dfx()",
    lineSuffix: "",
  })
}

function commentToCodePlan(linePrefix: string) {
  return {
    kind: "comment-to-code" as const,
    insertMode: "insert-after-line" as const,
    replaceCurrentWord: false,
    needsSymbolRetrieval: true,
    needsTestRetrieval: false,
    useFim: false,
    useInstruction: true,
    maxTokens: 384,
    confidenceFloor: 0.5,
    targetSymbol: "target_symbol",
  }
}

function postprocessPlan(input: {
  kind?: "ordinary-code" | "previous-comment-continuation"
  insertMode: "replace-current-word" | "insert-at-cursor" | "insert-after-line" | "replace-whole-line"
  replaceCurrentWord?: boolean
}) {
  return {
    kind: input.kind ?? "ordinary-code",
    insertMode: input.insertMode,
    replaceCurrentWord: input.replaceCurrentWord ?? false,
    confidenceFloor: 0,
  }
}

function indent(currentIndent = "", targetIndent = "    ") {
  return {
    currentIndent,
    targetIndent,
    indentUnit: "    ",
  }
}
