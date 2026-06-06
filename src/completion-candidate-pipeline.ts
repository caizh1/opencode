import {
  adaptAndValidateInlineCompletionEdit,
  buildInlineCompletionEditResult,
  type CompletionEdit,
  type CompletionEditInput,
  type CompletionSelectedCompletionInfo,
} from "./completion-edit"
import { completionPostprocessDebug, postprocessCompletion, trimCompletionForCIntent, type CompletionPostprocessDebug } from "./completion-postprocess"
import { fallbackCompletionText } from "./completion-test-fallback"
import { completionInsertText } from "./completion-text"
import type { CompletionPlan, RetrievedCompletionSnippet } from "./completion-types"
import type { CompletionProfile, OpenCodeMessage } from "./types"

export type CompletionCandidateDecision = "accepted" | "rejected"

export type CompletionCandidatePipelineInput = {
  response?: OpenCodeMessage
  rawText?: string
  textProfile: CompletionProfile
  editInput: Omit<CompletionEditInput, "text">
  plan: CompletionPlan
  retrievedSnippets: RetrievedCompletionSnippet[]
  selectedCompletionInfo?: CompletionSelectedCompletionInfo
  documentSuffix?: string
}

export type CompletionCandidatePipelineResult = {
  rawText: string
  postprocessText: string
  fallbackText: string
  candidateText: string
  editText: string
  edit?: CompletionEdit
  decision: CompletionCandidateDecision
  reasons: string[]
  rejectionReason?: string
  postprocessDebug: CompletionPostprocessDebug
  latencyMs: {
    postprocess: number
    edit: number
    total: number
  }
}

export function runCompletionCandidatePipeline(input: CompletionCandidatePipelineInput): CompletionCandidatePipelineResult {
  const started = Date.now()
  const rawText = input.rawText ?? completionInsertText(input.response, input.textProfile)
  const postprocessStarted = Date.now()
  const postprocessResult = rawText
    ? postprocessCompletion({
        rawText,
        linePrefix: input.editInput.linePrefix,
        lineSuffix: input.editInput.lineSuffix,
        currentWord: input.editInput.currentWord,
        fullCurrentLine: `${input.editInput.linePrefix}${input.editInput.lineSuffix}`,
        languageId: input.editInput.languageId,
        plan: input.plan,
        indent: {
          currentIndent: lineIndent(input.editInput.linePrefix),
          targetIndent: input.editInput.indent.targetIndent,
          indentUnit: input.editInput.indent.indentUnit,
        },
      })
    : {
        text: "" as const,
        rejected: true as const,
        reason: "empty-output" as const,
      }
  const postprocessMs = elapsedMs(postprocessStarted)
  const postprocessDebug = completionPostprocessDebug(postprocessResult) ?? { prefixMode: "none" as const }
  const postprocessText = postprocessResult.text
  const fallbackText =
    fallbackCompletionText({
      languageId: input.editInput.languageId,
      plan: input.plan,
      retrievedSnippets: input.retrievedSnippets,
      rejectReason: postprocessResult.reason,
    }) ||
    fallbackSymbolText(input.plan, input.retrievedSnippets, input.editInput.currentWord)
  const untrimmedCandidateText = postprocessText || fallbackText
  const candidateText = trimCompletionForCIntent({
    text: untrimmedCandidateText,
    cIntent: input.plan.cIntent,
    linePrefix: input.editInput.linePrefix,
    lineSuffix: input.editInput.lineSuffix,
    languageId: input.editInput.languageId,
  })

  if (!candidateText) {
    const reason = postprocessResult.rejected ? postprocessResult.reason : "filtered-or-no-visible-text"
    return {
      rawText,
      postprocessText,
      fallbackText,
      candidateText,
      editText: "",
      decision: "rejected",
      reasons: [`postprocess:${reason}`],
      rejectionReason: reason,
      postprocessDebug,
      latencyMs: {
        postprocess: postprocessMs,
        edit: 0,
        total: elapsedMs(started),
      },
    }
  }

  const intentRejectReason = commentCodeCandidateRejectReason({
    candidateText,
    documentSuffix: input.documentSuffix,
    plan: input.plan,
  })
  if (intentRejectReason) {
    return {
      rawText,
      postprocessText,
      fallbackText,
      candidateText,
      editText: "",
      decision: "rejected",
      reasons: [`intent:${intentRejectReason}`],
      rejectionReason: intentRejectReason,
      postprocessDebug,
      latencyMs: {
        postprocess: postprocessMs,
        edit: 0,
        total: elapsedMs(started),
      },
    }
  }

  const editStarted = Date.now()
  let editText = candidateText
  let result = buildInlineCompletionEditResult({
    text: candidateText,
    ...input.editInput,
    plan: input.plan,
  })
  if (!result.edit && fallbackText && fallbackText !== candidateText) {
    editText = fallbackText
    result = buildInlineCompletionEditResult({
      text: fallbackText,
      ...input.editInput,
      plan: input.plan,
    })
  }
  const editMs = elapsedMs(editStarted)

  if (!result.edit) {
    return {
      rawText,
      postprocessText,
      fallbackText,
      candidateText,
      editText,
      decision: "rejected",
      reasons: [`edit:${result.reason}`],
      rejectionReason: result.reason,
      postprocessDebug,
      latencyMs: {
        postprocess: postprocessMs,
        edit: editMs,
        total: elapsedMs(started),
      },
    }
  }

  const validation = adaptAndValidateInlineCompletionEdit({
    edit: result.edit,
    editInput: input.editInput,
    plan: input.plan,
    selectedCompletionInfo: input.selectedCompletionInfo,
  })
  if (validation.status === "rejected") {
    return {
      rawText,
      postprocessText,
      fallbackText,
      candidateText,
      editText,
      edit: result.edit,
      decision: "rejected",
      reasons: [`contract:${validation.reason}`],
      rejectionReason: validation.reason,
      postprocessDebug,
      latencyMs: {
        postprocess: postprocessMs,
        edit: editMs,
        total: elapsedMs(started),
      },
    }
  }

  return {
    rawText,
    postprocessText,
    fallbackText,
    candidateText,
    editText,
    edit: validation.edit,
    decision: "accepted",
    reasons: [
      ...(postprocessResult.reason ? [`postprocess:${postprocessResult.reason}`] : []),
      ...(fallbackText && editText === fallbackText && fallbackText !== postprocessText ? ["fallback:used"] : []),
    ],
    postprocessDebug,
    latencyMs: {
      postprocess: postprocessMs,
      edit: editMs,
      total: elapsedMs(started),
    },
  }
}

function fallbackSymbolText(plan: CompletionPlan, snippets: RetrievedCompletionSnippet[], currentWord: string | undefined) {
  if (!plan.replaceCurrentWord || !currentWord) return ""
  const current = currentWord.toLowerCase()
  return snippets
    .map((snippet) => snippet.name ?? "")
    .find((name) => name.toLowerCase().startsWith(current) && name.length > currentWord.length) ?? ""
}

function commentCodeCandidateRejectReason(input: {
  candidateText: string
  documentSuffix?: string
  plan: CompletionPlan
}) {
  if (!isCommentCodeInstructionPlan(input.plan)) return ""
  if (startsWithDocumentSuffix(input.candidateText, input.documentSuffix)) return "suffix-duplicated-output"
  if (isLowIntentCommentCodeOutput(input.candidateText, input.plan.sourceComment ?? "")) return "low-intent-output"
  return ""
}

function isCommentCodeInstructionPlan(plan: CompletionPlan) {
  return plan.kind === "comment-to-code" ||
    (plan.kind === "previous-comment-continuation" && Boolean(plan.sourceComment) && !plan.needsTestRetrieval)
}

function startsWithDocumentSuffix(candidateText: string, documentSuffix: string | undefined) {
  const suffixLine = firstNonEmptyLine(documentSuffix ?? "")
  const candidateLine = firstNonEmptyLine(candidateText)
  if (!suffixLine || !candidateLine || suffixLine.length < 6) return false
  return candidateLine === suffixLine || candidateText.trimStart().startsWith(`${suffixLine}\n`)
}

function isLowIntentCommentCodeOutput(candidateText: string, sourceComment: string) {
  const comment = stripCommentMarker(sourceComment)
  if (!hasActionableCodeIntent(comment)) return false
  if (explicitlyAsksForGenericReturn(comment)) return false

  const text = candidateText.trim()
  return /^return\s*(?:;|\s+(?:0|0u|NULL|nullptr|true|false|ret|retval|result|status|err|rc)\s*;?)$/i.test(text)
}

function hasActionableCodeIntent(comment: string) {
  return /\b(?:add|create|generate|implement|write|fix|handle|clean\s*up|cleanup|initialize|init|check|validate|guard|release|close|free|unlock)\b/i.test(comment)
}

function explicitlyAsksForGenericReturn(comment: string) {
  return /\breturn\s+(?:0|0u|NULL|nullptr|true|false|ret|retval|result|status|err|rc)\b/i.test(comment)
}

function firstNonEmptyLine(input: string) {
  return input.replace(/\r\n/g, "\n").split("\n").find((line) => line.trim())?.trim() ?? ""
}

function stripCommentMarker(input: string) {
  return input
    .trim()
    .replace(/^\/\/\s*/, "")
    .replace(/^#\s*/, "")
    .replace(/^\/\*\s*/, "")
    .replace(/\s*\*\/$/, "")
}

function lineIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] ?? ""
}

function elapsedMs(started: number) {
  return Date.now() - started
}
