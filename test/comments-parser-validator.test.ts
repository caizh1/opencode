import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { collectCommentInsertionAnchors } from "../src/comments/commentAnchors"
import { parseCommentProposalResponse, summarizeCommentProposalResponse } from "../src/comments/commentProposalParser"
import { discardReasonHistogram, validateRawCommentProposals } from "../src/comments/commentProposalValidator"
import { commentPreviewText } from "../src/comments/commentPreview"
import type { RawCommentProposal } from "../src/comments/commentTypes"

describe("AI comment proposal parser", () => {
  test("parses strict JSON proposal responses", () => {
    const parsed = parseCommentProposalResponse(JSON.stringify({
      proposals: [validProposal()],
    }))

    expect(parsed).toMatchObject({
      ok: true,
      proposals: [expect.objectContaining({
        kind: "logicBlock",
        insertBeforeLine: 12,
        confidence: "high",
      })],
    })
  })

  test("rejects markdown code fences", () => {
    expect(parseCommentProposalResponse("```json\n{\"proposals\":[]}\n```")).toEqual({
      ok: false,
      reason: "不允许 markdown code fence",
    })
  })

  test("summarizes proposal responses without logging comment text", () => {
    expect(summarizeCommentProposalResponse(JSON.stringify({
      proposals: [validProposal()],
    }))).toEqual({
      kind: "structured",
      proposalCount: 1,
      proposals: [{
        index: 0,
        kind: "logicBlock",
        confidence: "high",
        insertBeforeLine: 12,
        commentBytes: expect.any(Number),
        reasonBytes: expect.any(Number),
        anchorBytes: expect.any(Number),
        evidenceSpanCount: 1,
        selectionEvidenceCount: 1,
        repositoryEvidenceCount: 0,
        evidenceRanges: [{
          source: "selection",
          startLine: 12,
          endLine: 12,
        }],
      }],
    })
    expect(summarizeCommentProposalResponse("not json")).toEqual({
      kind: "raw",
      preview: "not json",
    })
  })
})

describe("AI comment proposal validator", () => {
  test("accepts legal line comments", () => {
    const result = validateRawCommentProposals([
      validProposal({
        commentText: "// 在移交队列 ownership 前保留当前 owner 关系。",
        reason: "ownership 移交流程不直观。",
      }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(1)
    expect(result.discarded).toEqual([])
  })

  test("rejects non-comment code", () => {
    const result = validateRawCommentProposals([
      validProposal({ commentText: "return 0;" }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(0)
    expect(result.discarded[0]?.reason).toBe("commentText 只能包含注释")
  })

  test("rejects insertBeforeLine outside the selected range", () => {
    const result = validateRawCommentProposals([
      validProposal({ insertBeforeLine: 30 }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(0)
    expect(result.discarded[0]?.reason).toBe("insertBeforeLine 超出选区范围")
  })

  test("rejects low confidence proposals", () => {
    const result = validateRawCommentProposals([
      validProposal({ confidence: "low" }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(0)
    expect(result.discarded[0]?.reason).toBe("低置信度注释候选已忽略")
  })

  test("rejects too-long comments and proposals beyond the dynamic cap", () => {
    const many = Array.from({ length: 5 }, (_, index) => validProposal({ insertBeforeLine: 10 + index }))
    const defaultCapped = validateRawCommentProposals(many, { selectionStartLine: 10, selectionEndLine: 30, allowedInsertBeforeLines: [10, 11, 12, 13, 14] })
    const dynamicCapped = validateRawCommentProposals(many, { selectionStartLine: 10, selectionEndLine: 30, allowedInsertBeforeLines: [10, 11, 12, 13, 14], maxProposals: 5 })
    const hardCapped = validateRawCommentProposals(
      Array.from({ length: 10 }, (_, index) => validProposal({ insertBeforeLine: 10 + index })),
      { selectionStartLine: 10, selectionEndLine: 30, allowedInsertBeforeLines: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], maxProposals: 12 },
    )
    const tooLong = validateRawCommentProposals([
      validProposal({ commentText: `// ${"x".repeat(1000)}` }),
    ], selectionContext())

    expect(defaultCapped.proposals).toHaveLength(3)
    expect(defaultCapped.discarded).toContainEqual({ index: 3, reason: "注释候选数量超过动态上限" })
    expect(dynamicCapped.proposals).toHaveLength(5)
    expect(dynamicCapped.discarded).toEqual([])
    expect(hardCapped.proposals).toHaveLength(8)
    expect(hardCapped.discarded).toContainEqual({ index: 8, reason: "注释候选数量超过动态上限" })
    expect(tooLong.proposals).toHaveLength(0)
    expect(tooLong.discarded[0]?.reason).toBe("commentText 过长")
  })

  test("aggregates discard reasons for diagnostics", () => {
    const result = validateRawCommentProposals([
      validProposal({ confidence: "low" }),
      validProposal({ insertBeforeLine: 30 }),
      validProposal({ insertBeforeLine: 31 }),
    ], selectionContext())

    expect(discardReasonHistogram(result.discarded)).toEqual({
      "低置信度注释候选已忽略": 1,
      "insertBeforeLine 超出选区范围": 2,
    })
  })

  test("rejects proposals outside allowed structural anchors", () => {
    const result = validateRawCommentProposals([
      validProposal({ insertBeforeLine: 13 }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(0)
    expect(result.discarded[0]?.reason).toBe("insertBeforeLine 不是允许的结构锚点")
  })

  test("requires code evidence tied to the selected range", () => {
    const missing = validateRawCommentProposals([
      validProposal({ codeEvidence: undefined as never }),
    ], selectionContext())
    const empty = validateRawCommentProposals([
      validProposal({ codeEvidence: [] }),
    ], selectionContext())
    const fieldEmpty = validateRawCommentProposals([
      validProposal({ codeEvidence: [codeEvidence({ codeSummary: "" })] }),
    ], selectionContext())
    const outOfRange = validateRawCommentProposals([
      validProposal({ codeEvidence: [codeEvidence({ startLine: 9, endLine: 12 })] }),
    ], selectionContext())
    const repositoryOnly = validateRawCommentProposals([
      validProposal({ codeEvidence: [codeEvidence({ source: "repository", filePath: "src/owner.c", startLine: 30, endLine: 32 })] }),
    ], selectionContext())
    const tooMany = validateRawCommentProposals([
      validProposal({ codeEvidence: [codeEvidence(), codeEvidence(), codeEvidence(), codeEvidence()] }),
    ], selectionContext())

    expect(missing.discarded[0]?.reason).toBe("codeEvidence 必须是非空数组")
    expect(empty.discarded[0]?.reason).toBe("codeEvidence 必须是非空数组")
    expect(fieldEmpty.discarded[0]?.reason).toBe("codeEvidence.codeSummary 不能为空")
    expect(outOfRange.discarded[0]?.reason).toBe("codeEvidence 选区行号超出选区范围")
    expect(repositoryOnly.discarded[0]?.reason).toBe("codeEvidence 必须包含选区代码证据")
    expect(tooMany.discarded[0]?.reason).toBe("codeEvidence 数量超过上限")
  })

  test("repairs adjacent insertBeforeLine when anchor text uniquely matches an allowed anchor", () => {
    const result = validateRawCommentProposals([
      validProposal({
        insertBeforeLine: 11,
        anchor: { targetLineText: "if (owner->ready) {" },
      }),
    ], selectionContext({
      allowedInsertBeforeLines: [12],
      allowedAnchors: [{ line: 12, targetLineText: "if (owner->ready) {" }],
    }))

    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0]?.insertBeforeLine).toBe(12)
    expect(result.repairs).toEqual([{
      index: 0,
      anchorLineRepaired: true,
      originalInsertBeforeLine: 11,
      repairedInsertBeforeLine: 12,
      repairReason: "anchor.targetLineText 唯一匹配允许锚点，修正相邻行号",
    }])
    expect(result.discarded).toEqual([])
  })

  test("does not repair adjacent insertBeforeLine when anchor text does not match", () => {
    const result = validateRawCommentProposals([
      validProposal({
        insertBeforeLine: 11,
        anchor: { targetLineText: "if (wrong->ready) {" },
      }),
    ], selectionContext({
      allowedInsertBeforeLines: [12],
      allowedAnchors: [{ line: 12, targetLineText: "if (owner->ready) {" }],
    }))

    expect(result.proposals).toHaveLength(0)
    expect(result.repairs).toEqual([])
    expect(result.discarded[0]?.reason).toBe("insertBeforeLine 不是允许的结构锚点")
  })

  test("does not repair insertBeforeLine when anchor text matches multiple allowed anchors", () => {
    const result = validateRawCommentProposals([
      validProposal({
        insertBeforeLine: 13,
        anchor: { targetLineText: "if (owner->ready) {" },
      }),
    ], selectionContext({
      allowedInsertBeforeLines: [12, 14],
      allowedAnchors: [
        { line: 12, targetLineText: "if (owner->ready) {" },
        { line: 14, targetLineText: "if (owner->ready) {" },
      ],
    }))

    expect(result.proposals).toHaveLength(0)
    expect(result.repairs).toEqual([])
    expect(result.discarded[0]?.reason).toBe("insertBeforeLine 不是允许的结构锚点")
  })

  test("allows natural-language comments that mention code symbols", () => {
    const result = validateRawCommentProposals([
      validProposal({
        commentText: "// 这里强调 owner = frontend 的关系，以及 { } 代表状态范围。",
      }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(1)
    expect(result.discarded).toEqual([])
  })

  test("allows function header comments that mention signatures and control conditions as prose", () => {
    const result = validateRawCommentProposals([
      validProposal({
        kind: "functionHeader",
        commentText: "/**\n * hub_chr_read(void *opaque, const uint8_t *buf, int size) 负责在 if (fe && fe->chr_read) 成立时转发数据，{ } 只是描述控制块范围。\n */",
      }),
    ], selectionContext())

    expect(result.proposals).toHaveLength(1)
    expect(result.discarded).toEqual([])
  })

  test("rejects standalone code statements inside comments", () => {
    const result = validateRawCommentProposals([
      validProposal({ commentText: "// if (ready) {" }),
      validProposal({ commentText: "// return result;" }),
      validProposal({ commentText: "// owner = next_owner;" }),
    ], selectionContext({ allowedInsertBeforeLines: [12, 13, 14], maxProposals: 3 }))

    expect(result.proposals).toHaveLength(0)
    expect(discardReasonHistogram(result.discarded)).toEqual({
      "commentText 看起来像代码": 3,
    })
  })
})

describe("AI comment insertion anchors", () => {
  test("extracts function starts, selection starts, and control blocks", () => {
    const document = documentShim([
      "static void run_owner(owner_t *owner)",
      "{",
      "    int value = 0;",
      "    process_queue(owner);",
      "    if (owner->ready) {",
      "        do_work(owner);",
      "    }",
      "}",
    ])

    expect(collectCommentInsertionAnchors(document, 0, 7).map((anchor) => [anchor.line, anchor.kind])).toEqual([
      [0, "function"],
      [4, "controlBlock"],
    ])
    expect(collectCommentInsertionAnchors(document, 2, 6).map((anchor) => [anchor.line, anchor.kind])).toEqual([
      [2, "selectionStart"],
      [4, "controlBlock"],
    ])
  })

  test("marks multiline function signature starts as function-like anchors", () => {
    const document = documentShim([
      "static void hub_chr_read(void *opaque,",
      "                         const uint8_t *buf,",
      "                         int size)",
      "{",
      "    if (ready) {",
      "        do_work();",
      "    }",
      "}",
    ])

    expect(collectCommentInsertionAnchors(document, 0, 7).map((anchor) => [anchor.line, anchor.kind])).toEqual([
      [0, "functionLikeStart"],
      [4, "controlBlock"],
    ])
  })

  test("does not anchor ordinary statements unless they start the selection", () => {
    const document = documentShim([
      "    int value = 0;",
      "    process_queue(owner);",
      "    notify_owner(owner);",
      "    while (value < limit) {",
      "        value++;",
      "    }",
    ])

    expect(collectCommentInsertionAnchors(document, 0, 5).map((anchor) => [anchor.line, anchor.kind])).toEqual([
      [0, "selectionStart"],
      [3, "controlBlock"],
    ])
  })

  test("skips macro continuations and block comments", () => {
    const document = documentShim([
      "#define DO_WORK(x) \\",
      "    do_work(x)",
      "/*",
      " * if (documented) {",
      " */",
      "    if (ready) {",
      "        do_work(owner);",
      "    }",
    ])

    expect(collectCommentInsertionAnchors(document, 0, 7).map((anchor) => [anchor.line, anchor.kind])).toEqual([
      [5, "controlBlock"],
    ])
  })
})

describe("AI comment apply service source guard", () => {
  const applySource = readFileSync(join(import.meta.dir, "..", "src", "comments", "commentApplyService.ts"), "utf8")

  test("only uses WorkspaceEdit.insert for accepted comments", () => {
    expect(applySource).toContain("workspaceEdit.insert(")
    expect(applySource).not.toContain("workspaceEdit.replace(")
    expect(applySource).not.toContain("workspaceEdit.delete(")
  })
})

describe("AI comment preview text", () => {
  test("builds diff-like previews for line comments", () => {
    expect(commentPreviewText("// 在移交 work 前保留 queue owner 的可见性。")).toBe(
      "+ // 在移交 work 前保留 queue owner 的可见性。",
    )
  })

  test("truncates multiline line comments to the first meaningful line", () => {
    expect(commentPreviewText([
      "// 只有 frontend 存在活跃 chr_read handler 时才转发 read",
      "// 这样断开的 frontend 不会收到 callback。",
    ].join("\n"))).toBe("+ // 只有 frontend 存在活跃 chr_read handler 时才转发 read...")
  })

  test("builds block comment previews from the first meaningful body line", () => {
    expect(commentPreviewText([
      "/**",
      " * 在释放 ownership 前说明状态迁移约束。",
      " */",
    ].join("\n"))).toBe("+ /** 在释放 ownership 前说明状态迁移约束。 */")
  })

  test("falls back safely for empty comment wrappers", () => {
    expect(commentPreviewText("/**\n */")).toBe("+ /** 可预览 AI 注释候选 */")
  })
})

function selectionContext(overrides: {
  selectionStartLine?: number
  selectionEndLine?: number
  allowedInsertBeforeLines?: number[]
  allowedAnchors?: Array<{ line: number; targetLineText: string }>
  maxProposals?: number
} = {}) {
  return {
    ...baseSelectionContext(),
    ...overrides,
  }
}

function baseSelectionContext() {
  return {
    selectionStartLine: 10,
    selectionEndLine: 20,
    allowedInsertBeforeLines: [12],
  }
}

function documentShim(lines: string[]) {
  return {
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line],
    }),
  }
}

function validProposal(overrides: Partial<RawCommentProposal> = {}): RawCommentProposal {
  return {
    kind: "logicBlock",
    insertBeforeLine: 12,
    indent: "    ",
    commentText: "// 在移交 work 前保留 queue owner 的可见性。",
    anchor: {
      targetLineText: "process_queue(owner);",
    },
    confidence: "high",
    reason: "ownership 移交流程不直观。",
    codeEvidence: [codeEvidence()],
    ...overrides,
  }
}

function codeEvidence(overrides: Partial<RawCommentProposal["codeEvidence"][number]> = {}): RawCommentProposal["codeEvidence"][number] {
  return {
    source: "selection",
    startLine: 12,
    endLine: 12,
    anchorLabel: "logicBlock",
    codeSummary: "这一行处理 queue owner 的 work handoff。",
    meaning: "它说明注释要解释 ownership 移交流程，而不是复述调用语法。",
    ...overrides,
  }
}
