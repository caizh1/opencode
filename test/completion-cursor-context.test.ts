import { describe, expect, test } from "bun:test"
import { extractCommentGuidedCursorContext, statementHoleKind } from "../src/completion-cursor-context"

describe("comment-guided cursor context extractor", () => {
  test("extracts C flow context around a blank statement hole", () => {
    const prefix = [
      "static int controller_init(struct controller *ctrl)",
      "{",
      "    int ret = controller_power_on(ctrl);",
      "    // step2: wait clock reset",
      "    ",
    ].join("\n")
    const suffix = [
      "",
      "    MSG(DRV_C, 0, \"step2. wait clock reset\\r\\n\");",
      "    controller_enable(ctrl);",
      "    return ret;",
      "}",
    ].join("\n")

    const features = extractCommentGuidedCursorContext({
      prefix,
      suffix,
      sourceComment: "// step2: wait clock reset",
    })

    expect(features.currentFunctionName).toBe("controller_init")
    expect(features.statementHoleKind).toBe("blank-statement")
    expect(features.previousStatementCalls).toContain("controller_power_on")
    expect(features.nextStatementCalls).toContain("MSG")
    expect(features.nextStatementCalls).toContain("controller_enable")
    expect(features.nearbyLogOrMessageText.some((text) => text.includes("wait clock reset"))).toBe(true)
    expect(features.flowOrdinalTokens).toContain("step2")
    expect(features.visibleLocals).toContain("ret")
    expect(features.visibleIdentifiers).toContain("controller_power_on")
  })

  test("classifies partial local code holes without forcing helper insertion", () => {
    expect(statementHoleKind("    ret = ")).toBe("assignment-rhs")
    expect(statementHoleKind("    if (")).toBe("condition")
    expect(statementHoleKind("    req->")).toBe("member-access")
    expect(statementHoleKind("    helper(")).toBe("call-statement")
  })

  test("keeps empty current-function cursor context scoped away from adjacent functions", () => {
    const features = extractCommentGuidedCursorContext({
      prefix: [
        "static void empty_init(struct controller *ctrl)",
        "{",
        "    ",
      ].join("\n"),
      suffix: [
        "",
        "}",
      ].join("\n"),
      currentFunctionName: "empty_init",
      cursorContextScope: "current-function",
      currentFunctionBodyIsEmpty: true,
    })

    expect(features.statementHoleKind).toBe("empty-function-body")
    expect(features.cursorContextScope).toBe("current-function")
    expect(features.currentFunctionBodyIsEmpty).toBe(true)
    expect(features.previousStatementCalls).toEqual([])
    expect(features.nextStatementCalls).toEqual([])
    expect(features.scopedPreviousStatementCalls).toEqual([])
    expect(features.scopedNextStatementCalls).toEqual([])
    expect(features.nearbyLogOrMessageText).toEqual([])
    expect(features.visibleLocals).toContain("ctrl")
  })
})
