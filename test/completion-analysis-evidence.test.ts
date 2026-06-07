import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("completion analysis evidence routing", () => {
  test("direct FIM completion evidence does not force graph-only retrieval", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "completion.ts"), "utf8")
    const start = source.indexOf("private async retrieveCompletionAnalysisEvidence")
    const end = source.indexOf("private completionOutcomeFromResponse")
    const method = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(method).toContain("completionAnalysisEvidenceOptions")
    expect(method).not.toContain('retrievalMode: "graph-only"')
  })
})
