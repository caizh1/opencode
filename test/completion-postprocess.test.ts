import { describe, expect, test } from "bun:test"
import { postprocessCompletion } from "../src/completion-postprocess"
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

  test("keeps deterministic current-word symbol expansions intact", () => {
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
    })).toEqual({
      text: "epr_ppn_raw_write_with_cb_dfx",
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

function indent(currentIndent = "", targetIndent = "    ") {
  return {
    currentIndent,
    targetIndent,
    indentUnit: "    ",
  }
}
