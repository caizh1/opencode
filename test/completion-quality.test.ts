import { describe, expect, test } from "bun:test"
import { runCompletionCandidatePipeline } from "../src/completion-candidate-pipeline"
import { inferCompletionIndent } from "../src/completion-indent"
import { planCompletion } from "../src/completion-plan"
import { scoreCompletionQuality, type CompletionQualityFixture } from "../src/completion-quality"
import fixtures from "./completion-quality/fixtures/core"

describe("completion quality fixtures", () => {
  test("cover at least sixty scenarios with required eval fields", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(60)
    const ids = new Set<string>()
    for (const fixture of fixtures) {
      expect(fixture.id).toBeTruthy()
      expect(ids.has(fixture.id)).toBe(false)
      ids.add(fixture.id)
      expect(fixture.languageId).toBeTruthy()
      expect(fixture.filePath).toBeTruthy()
      expect(fixture.document).toContain("<|cursor|>")
      expect(["automatic", "manual"]).toContain(fixture.triggerKind)
      expect(fixture.expectedIntent).toBeTruthy()
      expect(Array.isArray(fixture.mustContain)).toBe(true)
      expect(Array.isArray(fixture.mustNotContain)).toBe(true)
      expect(fixture.maxLines).toBeGreaterThanOrEqual(1)
      expect(fixture.checks.length).toBeGreaterThan(0)
    }
  })
})

describe("completion quality scorer", () => {
  test("labels missing intent, hallucinated APIs, too-long output, and instability", () => {
    const fixture: CompletionQualityFixture = {
      id: "quality-bad",
      languageId: "typescript",
      filePath: "src/bad.ts",
      document: "return <|cursor|>\n",
      triggerKind: "automatic",
      expectedIntent: "return project value",
      mustContain: ["return projectValue;"],
      mustNotContain: ["nonexistentApi"],
      maxLines: 1,
      checks: ["edit-contract", "syntax-format", "intent-match", "project-context", "auto-show", "stability", "latency"],
      contextMustContain: ["projectValue"],
    }
    const score = scoreCompletionQuality({
      fixture,
      outcome: {
        rawText: "nonexistentApi()\nconst extra = 1",
        postprocessText: "nonexistentApi()\nconst extra = 1",
        fallbackText: "",
        candidateText: "nonexistentApi()\nconst extra = 1",
        editText: "nonexistentApi()\nconst extra = 1",
        edit: {
          insertText: "nonexistentApi()\nconst extra = 1",
          replaceRange: { startLine: 0, startCharacter: 7, endLine: 0, endCharacter: 7 },
          filterText: "nonexistentApi()\nconst extra = 1",
        },
        decision: "accepted",
        reasons: [],
        postprocessDebug: { prefixMode: "none" },
        latencyMs: { postprocess: 0, edit: 0, total: 450 },
      },
      acceptedText: "nonexistentApi()\nconst extra = 1",
      appliedText: "return nonexistentApi()\nconst extra = 1\n",
      linePrefix: "return ",
      lineSuffix: "",
      edit: {
        insertText: "nonexistentApi()\nconst extra = 1",
        replaceRange: { startLine: 0, startCharacter: 7, endLine: 0, endCharacter: 7 },
        filterText: "nonexistentApi()\nconst extra = 1",
      },
      repeatAcceptedTexts: ["nonexistentApi()", "projectValue"],
      repeatDecisions: ["accepted", "accepted"],
      latencyMs: 450,
      selectedContextText: "",
    })

    expect(score.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining([
      "intent mismatch",
      "hallucinated API",
      "too long",
      "project context miss",
      "unstable output",
      "latency risk",
    ]))
    expect(score.gate).toBe("reject")
  })
})

describe("completion candidate pipeline probe", () => {
  test("records raw, postprocess, candidate, edit, decision, and reasons", () => {
    const linePrefix = "    return "
    const plan = planCompletion({
      languageId: "typescript",
      linePrefix,
      lineSuffix: "",
    })
    const result = runCompletionCandidatePipeline({
      rawText: "value;",
      textProfile: "qwen-coder-fim",
      editInput: {
        languageId: "typescript",
        linePrefix,
        lineSuffix: "",
        position: { line: 0, character: linePrefix.length },
        indent: inferCompletionIndent({
          lines: [`${linePrefix}`],
          line: 0,
          linePrefix,
          fallbackIndentUnit: "    ",
        }),
      },
      plan,
      retrievedSnippets: [],
    })

    expect(result).toMatchObject({
      rawText: "value;",
      postprocessText: "value;",
      candidateText: "value;",
      fallbackText: "",
      decision: "accepted",
    })
    expect(result.edit?.insertText).toBe("value;")
  })
})
