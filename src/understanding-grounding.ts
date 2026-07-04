import type { RagStatus } from "./types"
import type {
  UnderstandingClaim,
  UnderstandingEvidenceAggregation,
  UnderstandingEvidenceCitation,
  UnderstandingFactorCategory,
} from "./understanding-planner"

export type UnderstandingAnswerConclusion = {
  id: string
  text: string
  factorCategory: UnderstandingFactorCategory
  evidenceRefs: Array<{ path: string; startLine: number; endLine: number }>
  confidence: "high" | "medium" | "low"
  hypothesis?: boolean
}

export type UnderstandingAnswerDraft = {
  conclusions: UnderstandingAnswerConclusion[]
  gaps: string[]
  hypotheses: string[]
  nextSteps: string[]
  coverageNotice?: string
}

export type UnderstandingCoverageContext = {
  codeGraphState?: string
  rag?: Pick<RagStatus, "enabled" | "availability" | "indexAvailability" | "embeddingEnabled" | "chunks" | "embeddedChunks" | "pendingChunkCount">
  retrievalMode?: "graph-only" | "hybrid"
}

export type UnderstandingGroundingFinding = {
  code:
    | "answer.no_conclusions"
    | "answer.missing_citation"
    | "answer.unknown_citation"
    | "answer.category_mismatch"
    | "answer.hypothesis_as_conclusion"
    | "answer.coverage_notice_missing"
  severity: "warning" | "blocking"
  conclusionId?: string
  message: string
}

export type UnderstandingGroundingVerification = {
  pass: boolean
  findings: UnderstandingGroundingFinding[]
  coverageNotice?: string
}

export function draftAnswerFromUnderstandingClaims(claims: UnderstandingClaim[]): UnderstandingAnswerDraft {
  const supported = claims.filter((claim) => claim.evidenceRefs.length > 0 && claim.supportLevel !== "counter")
  return {
    conclusions: supported.map((claim) => ({
      id: claim.id,
      text: claim.claim,
      factorCategory: claim.factorCategory,
      evidenceRefs: claim.evidenceRefs.map((evidence) => ({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
      })),
      confidence: claim.confidence === "high" ? "high" : claim.confidence === "medium" ? "medium" : "low",
    })),
    gaps: claims
      .filter((claim) => claim.evidenceRefs.length === 0 || claim.supportLevel === "counter")
      .map((claim) => claim.claim),
    hypotheses: claims.flatMap((claim) => claim.assumptions),
    nextSteps: ["Validate high-impact claims with focused tests or benchmarks before treating them as final conclusions."],
  }
}

export function verifyUnderstandingAnswerGrounding(input: {
  answer: UnderstandingAnswerDraft
  aggregation: UnderstandingEvidenceAggregation
  coverage?: UnderstandingCoverageContext
}): UnderstandingGroundingVerification {
  const evidence = evidenceCatalog(input.aggregation)
  const expectedCoverageNotice = coverageLimitNotice(input.coverage)
  const findings: UnderstandingGroundingFinding[] = []
  if (input.answer.conclusions.length === 0) {
    findings.push({
      code: "answer.no_conclusions",
      severity: "warning",
      message: "Answer contains no evidence-backed conclusions.",
    })
  }
  for (const conclusion of input.answer.conclusions) {
    if (conclusion.hypothesis) {
      findings.push({
        code: "answer.hypothesis_as_conclusion",
        severity: "blocking",
        conclusionId: conclusion.id,
        message: "A hypothesis is written as a main conclusion.",
      })
    }
    if (conclusion.evidenceRefs.length === 0) {
      findings.push({
        code: "answer.missing_citation",
        severity: "blocking",
        conclusionId: conclusion.id,
        message: "Main conclusion has no evidence reference.",
      })
      continue
    }
    for (const ref of conclusion.evidenceRefs) {
      const match = evidence.get(evidenceKey(ref.path, ref.startLine, ref.endLine))
      if (!match) {
        findings.push({
          code: "answer.unknown_citation",
          severity: "blocking",
          conclusionId: conclusion.id,
          message: `Citation ${ref.path}:${ref.startLine}-${ref.endLine} is not present in retrieved evidence.`,
        })
        continue
      }
      if (match.factorCategory !== conclusion.factorCategory) {
        findings.push({
          code: "answer.category_mismatch",
          severity: "warning",
          conclusionId: conclusion.id,
          message: `Citation ${ref.path}:${ref.startLine}-${ref.endLine} supports ${match.factorCategory}, not ${conclusion.factorCategory}.`,
        })
      }
    }
  }
  if (expectedCoverageNotice && !input.answer.coverageNotice?.includes(expectedCoverageNotice)) {
    findings.push({
      code: "answer.coverage_notice_missing",
      severity: "blocking",
      message: "Answer is missing the required index coverage limitation notice.",
    })
  }
  return {
    pass: findings.every((finding) => finding.severity !== "blocking"),
    findings,
    coverageNotice: expectedCoverageNotice,
  }
}

export function repairUnderstandingAnswerGrounding(input: {
  answer: UnderstandingAnswerDraft
  aggregation: UnderstandingEvidenceAggregation
  coverage?: UnderstandingCoverageContext
}): { answer: UnderstandingAnswerDraft; verification: UnderstandingGroundingVerification } {
  const evidence = evidenceCatalog(input.aggregation)
  const movedToHypotheses: string[] = []
  const repairedConclusions = input.answer.conclusions.flatMap((conclusion): UnderstandingAnswerConclusion[] => {
    if (conclusion.hypothesis || conclusion.evidenceRefs.length === 0) {
      movedToHypotheses.push(conclusion.text)
      return []
    }
    const validRefs = conclusion.evidenceRefs.filter((ref) => evidence.has(evidenceKey(ref.path, ref.startLine, ref.endLine)))
    if (validRefs.length === 0) {
      movedToHypotheses.push(conclusion.text)
      return []
    }
    const sameCategoryRefs = validRefs.filter((ref) => evidence.get(evidenceKey(ref.path, ref.startLine, ref.endLine))?.factorCategory === conclusion.factorCategory)
    return [{
      ...conclusion,
      evidenceRefs: sameCategoryRefs.length ? sameCategoryRefs : validRefs,
      confidence: sameCategoryRefs.length ? conclusion.confidence : "low",
    }]
  })
  const coverageNotice = coverageLimitNotice(input.coverage) ?? input.answer.coverageNotice
  const answer: UnderstandingAnswerDraft = {
    ...input.answer,
    conclusions: repairedConclusions,
    hypotheses: [...input.answer.hypotheses, ...movedToHypotheses],
    gaps: repairedConclusions.length ? input.answer.gaps : [...input.answer.gaps, "Evidence is insufficient for a firm conclusion; treat remaining points as hypotheses."],
    coverageNotice,
  }
  return {
    answer,
    verification: verifyUnderstandingAnswerGrounding({ answer, aggregation: input.aggregation, coverage: input.coverage }),
  }
}

export function coverageLimitNotice(coverage?: UnderstandingCoverageContext) {
  if (!coverage) return undefined
  const limits: string[] = []
  if (coverage.codeGraphState && coverage.codeGraphState !== "ready") limits.push(`CodeGraph state is ${coverage.codeGraphState}`)
  if (coverage.retrievalMode === "graph-only") limits.push("Code RAG was not used for this answer")
  const rag = coverage.rag
  if (rag?.enabled) {
    const pending = rag.pendingChunkCount ?? Math.max(0, (rag.chunks ?? 0) - (rag.embeddedChunks ?? 0))
    if (rag.availability !== "ready" || rag.indexAvailability !== "ready" || !rag.embeddingEnabled || pending > 0) {
      limits.push(`Code RAG is partially available: availability=${rag.availability ?? "unknown"} index=${rag.indexAvailability ?? "unknown"} pending=${pending}`)
    }
  }
  return limits.length ? `Coverage limit: ${limits.join("; ")}.` : undefined
}

function evidenceCatalog(aggregation: UnderstandingEvidenceAggregation) {
  const catalog = new Map<string, { citation: UnderstandingEvidenceCitation; factorCategory: UnderstandingFactorCategory }>()
  for (const factor of aggregation.factors) {
    for (const citation of factor.supportingEvidence) {
      catalog.set(evidenceKey(citation.path, citation.startLine, citation.endLine), {
        citation,
        factorCategory: factor.category,
      })
    }
  }
  return catalog
}

function evidenceKey(path: string, startLine: number, endLine: number) {
  return `${path}:${startLine}-${endLine}`
}
