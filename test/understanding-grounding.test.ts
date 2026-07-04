import { describe, expect, test } from "bun:test"
import {
  coverageLimitNotice,
  repairUnderstandingAnswerGrounding,
  verifyUnderstandingAnswerGrounding,
  type UnderstandingAnswerDraft,
} from "../src/understanding-grounding"
import type { UnderstandingEvidenceAggregation } from "../src/understanding-planner"

describe("understanding grounding verifier", () => {
  test("repairs ungrounded performance conclusions into hypotheses", () => {
    const aggregation = aggregationWithEvidence()
    const answer: UnderstandingAnswerDraft = {
      conclusions: [
        {
          id: "ungrounded",
          text: "GC is slow because batching is too small.",
          factorCategory: "batching",
          evidenceRefs: [],
          confidence: "high",
        },
      ],
      gaps: [],
      hypotheses: [],
      nextSteps: [],
    }

    const verification = verifyUnderstandingAnswerGrounding({ answer, aggregation })
    expect(verification.pass).toBe(false)
    expect(verification.findings.map((finding) => finding.code)).toContain("answer.missing_citation")

    const repaired = repairUnderstandingAnswerGrounding({ answer, aggregation })
    expect(repaired.answer.conclusions).toEqual([])
    expect(repaired.answer.hypotheses).toContain("GC is slow because batching is too small.")
    expect(repaired.answer.gaps.join("\n")).toContain("insufficient")
  })

  test("filters unknown citations and lowers category-mismatch confidence", () => {
    const aggregation = aggregationWithEvidence()
    const answer: UnderstandingAnswerDraft = {
      conclusions: [
        {
          id: "wrong",
          text: "Lock contention is present.",
          factorCategory: "concurrency",
          evidenceRefs: [
            { path: "src/missing.c", startLine: 1, endLine: 2 },
            { path: "src/gc.c", startLine: 10, endLine: 12 },
          ],
          confidence: "high",
        },
      ],
      gaps: [],
      hypotheses: [],
      nextSteps: [],
    }

    const repaired = repairUnderstandingAnswerGrounding({ answer, aggregation })
    expect(repaired.answer.conclusions[0]?.evidenceRefs).toEqual([{ path: "src/gc.c", startLine: 10, endLine: 12 }])
    expect(repaired.answer.conclusions[0]?.confidence).toBe("low")
    expect(repaired.verification.findings.map((finding) => finding.code)).toContain("answer.category_mismatch")
  })

  test("requires coverage limitation notice for partial index states", () => {
    const notice = coverageLimitNotice({
      codeGraphState: "indexing",
      retrievalMode: "graph-only",
      rag: {
        enabled: true,
        availability: "indexing",
        indexAvailability: "partial",
        embeddingEnabled: true,
        chunks: 10,
        embeddedChunks: 4,
        pendingChunkCount: 6,
      },
    })
    expect(notice).toContain("Coverage limit")

    const aggregation = aggregationWithEvidence()
    const answer: UnderstandingAnswerDraft = {
      conclusions: [
        {
          id: "scan",
          text: "Scan scope affects GC.",
          factorCategory: "scan_scope",
          evidenceRefs: [{ path: "src/gc.c", startLine: 10, endLine: 12 }],
          confidence: "medium",
        },
      ],
      gaps: [],
      hypotheses: [],
      nextSteps: [],
    }
    const verification = verifyUnderstandingAnswerGrounding({
      answer,
      aggregation,
      coverage: {
        codeGraphState: "indexing",
        retrievalMode: "graph-only",
        rag: {
          enabled: true,
          availability: "indexing",
          indexAvailability: "partial",
          embeddingEnabled: true,
          chunks: 10,
          embeddedChunks: 4,
        },
      },
    })

    expect(verification.pass).toBe(false)
    expect(verification.findings.map((finding) => finding.code)).toContain("answer.coverage_notice_missing")
  })
})

function aggregationWithEvidence(): UnderstandingEvidenceAggregation {
  return {
    evidenceCount: 1,
    omittedDuplicateEvidence: 0,
    gaps: [],
    claims: [],
    factors: [
      {
        label: "Scan scope and data volume",
        category: "scan_scope",
        confidence: "low",
        strength: "direct",
        hypothesis: false,
        gaps: [],
        supportingEvidence: [
          {
            path: "src/gc.c",
            startLine: 10,
            endLine: 12,
            snippetHash: "scan",
            source: "queryEvidence",
            taskType: "semantic_search",
            snippet: "scan all blocks",
          },
        ],
      },
    ],
  }
}
