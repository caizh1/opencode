import { describe, expect, test } from "bun:test"
import type { QueryEvidenceResult } from "../src/analysis-types"
import type { CodeGraphContextProvider, CodeGraphEvidence, CodeGraphEvidenceQueryOptions } from "../src/codegraph-types"
import { retrieveRepositoryEvidenceForIntent } from "../src/repository-evidence"

describe("repository evidence orchestrator", () => {
  test("shares QA-style retrieval candidates while projecting shorter completion evidence", async () => {
    const provider = providerWithEvidence([
      functionEvidence("src/driver/clock.c", 12, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    while (!clock_ready()) {\n        cpu_relax();\n    }\n}"),
      functionEvidence("src/driver/domain.c", 30, "domain_only_helper", "int domain_only_helper(void)\n{\n    return 0;\n}"),
      summaryEvidence("src/driver/current.c", "file src/driver/current.c: 2 function(s), 0 macro(s), 0 type(s)."),
    ])

    const qa = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "qa",
      task: "comment-guided-code",
      sourceComment: "// wait for clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 6,
      latencyBudgetMs: 1000,
    })
    const completion = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait for clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      prefix: "int init_controller(void)\n{\n",
      suffix: "\n}\n",
      nearbyIdentifiers: ["clock_ready"],
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(qa.trace.topCandidateNames).toContain("wait_clock_ready")
    expect(completion.trace.topCandidateNames).toContain("wait_clock_ready")
    expect(completion.trace.selectedCandidateNames).toContain("wait_clock_ready")
    expect(completion.completionPack.evidence.length).toBeLessThanOrEqual(2)
    expect(completion.completionPack.text).toContain("wait_clock_ready")
    expect(completion.completionPack.text).not.toContain("Grounded answer plan")
  })

  test("falls back to graph-only retrieval when the hybrid call times out", async () => {
    const calls: string[] = []
    const provider: Pick<CodeGraphContextProvider, "queryEvidence"> = {
      queryEvidence: async (_question: string, options?: CodeGraphEvidenceQueryOptions) => {
        calls.push(options?.retrievalMode ?? "hybrid")
        if (options?.retrievalMode === "hybrid") {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return undefined
        }
        return queryEvidenceResult([functionEvidence("src/driver/clock.c", 4, "poll_clock", "void poll_clock(void)\n{\n    while (!clock_ready()) {}\n}")], {
          steps: [{ label: "graph", detail: "graph fallback", elapsedMs: 1 }],
        })
      },
    }

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// poll clock",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      maxEvidence: 2,
      latencyBudgetMs: 5,
    })

    expect(calls).toEqual(["hybrid", "graph-only"])
    expect(result.trace.timedOut).toBe(true)
    expect(result.trace.timeoutStage).toBe("hybrid")
    expect(result.trace.retrievalMode).toBe("graph-only-fallback")
    expect(result.completionPack.text).toContain("poll_clock")
  })

  test("records rerank and RAG availability from the shared retrieval trace", async () => {
    const provider = providerWithEvidence([
      {
        ...functionEvidence("src/driver/clock.c", 12, "wait_clock_ready", "void wait_clock_ready(void)\n{\n    wait_until(clock_ready());\n}"),
        reason: "rerank: top match",
      },
    ], {
      steps: [
        { label: "vector", detail: "vector candidates", elapsedMs: 2 },
        { label: "rerank", detail: "reranked candidates", elapsedMs: 3 },
      ],
    })

    const result = await retrieveRepositoryEvidenceForIntent({
      codeGraph: provider,
      mode: "completion",
      task: "comment-guided-code",
      sourceComment: "// wait clock ready",
      currentFile: "src/driver/current.c",
      currentFunction: "init_controller",
      maxEvidence: 2,
      latencyBudgetMs: 1000,
    })

    expect(result.trace.retrievalMode).toBe("hybrid")
    expect(result.trace.rerankEnabled).toBe(true)
    expect(result.trace.ragAvailable).toBe(true)
    expect(result.trace.selectedCandidateNames).toContain("wait_clock_ready")
  })
})

function providerWithEvidence(evidence: CodeGraphEvidence[], trace?: { steps?: Array<{ label: string; detail: string; elapsedMs: number }> }): Pick<CodeGraphContextProvider, "queryEvidence"> {
  return {
    queryEvidence: async () => queryEvidenceResult(evidence, trace),
  }
}

function queryEvidenceResult(evidence: CodeGraphEvidence[], trace?: { steps?: Array<{ label: string; detail: string; elapsedMs: number }> }): QueryEvidenceResult {
  return {
    retrieval: {
      mode: "overview",
      tokens: [],
      symbols: evidence.map((item) => symbolName(item.snippet)).filter(Boolean),
      evidence,
      candidateCount: evidence.length,
      packedBytes: evidence.reduce((sum, item) => sum + item.snippet.length, 0),
      omittedCandidates: 0,
      truncated: false,
      elapsedMs: 1,
      trace: trace?.steps,
    },
    stateMachines: [],
    summaries: {
      functions: [],
      files: [],
      modules: [],
      subsystems: [],
    },
    evidencePack: {
      evidence: [],
      text: "Grounded answer plan: use the local helper.",
      packedBytes: 0,
      omittedEvidence: 0,
      truncated: false,
      missingEvidence: [],
    },
    trace: {
      traceId: "test-trace",
      question: "test question",
      intent: "overview",
      steps: trace?.steps ?? [{ label: "graph", detail: "graph candidates", elapsedMs: 1 }],
      evidence: [],
      missingEvidence: [],
    },
    answerPolicy: {
      allowed: true,
      confidence: "high",
      reason: "test",
      requiredCitation: "",
    },
    suggestedAnswer: "Grounded answer plan: call wait_clock_ready().",
  }
}

function functionEvidence(path: string, line: number, name: string, snippet: string): CodeGraphEvidence {
  return {
    path,
    startLine: line,
    endLine: line + snippet.split(/\r?\n/).length - 1,
    kind: "function",
    score: 240,
    reason: "seed function",
    snippet,
  }
}

function summaryEvidence(path: string, snippet: string): CodeGraphEvidence {
  return {
    path,
    startLine: 1,
    endLine: 1,
    kind: "text",
    score: 400,
    reason: "file summary",
    snippet,
  }
}

function symbolName(snippet: string) {
  return /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(snippet)?.[1] ?? ""
}
