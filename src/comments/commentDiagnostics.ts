import { createHash } from "node:crypto"
import type * as vscode from "vscode"
import type { CommentGenerationContext } from "./commentTypes"

export type CommentGenerationTerminalReason =
  | "selection-invalid"
  | "unsupported-language"
  | "selection-empty"
  | "selection-no-anchors"
  | "evidence-unavailable"
  | "evidence-no-graph-results"
  | "tools-disabled"
  | "tool-loop-failed"
  | "tool-loop-exhausted"
  | "tool-evidence-empty"
  | "model-request-failed"
  | "model-returned-only-thinking"
  | "model-output-truncated"
  | "model-non-json-prefix"
  | "graph-only-returned-empty-array"
  | "hybrid-returned-empty-array"
  | "tool-driven-returned-empty-array"
  | "parse-failed"
  | "validator-filtered-all"
  | "workspace-changes-scan-failed"
  | "proposals-stored"

export type CommentResponsePreview =
  | {
      kind: "structured"
      proposalCount: number
      proposals: Array<{
        index: number
        kind?: string
        confidence?: string
        insertBeforeLine?: number
        commentBytes: number
        reasonBytes: number
        anchorBytes: number
        evidenceSpanCount: number
        selectionEvidenceCount: number
        repositoryEvidenceCount: number
        evidenceRanges: Array<{
          source?: string
          startLine?: number
          endLine?: number
        }>
      }>
    }
  | {
      kind: "raw"
      preview: string
    }

export type CommentGenerationTraceContext = {
  traceId: string
  extensionVersion?: string
  workspacePath?: string
  workspacePathHash?: string
  uriHash?: string
  selectionHash?: string
}

export type CommentDiagnosticStageEvent = {
  stage: string
  fields?: Record<string, unknown>
}

const LOG_PREFIX = "[ChipMate Comment]"

export function createCommentTraceContext(extensionVersion?: string): CommentGenerationTraceContext {
  return {
    traceId: `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    extensionVersion,
  }
}

export function enrichCommentTraceContext(
  trace: CommentGenerationTraceContext,
  context: CommentGenerationContext,
): CommentGenerationTraceContext {
  return {
    ...trace,
    workspacePath: context.workspacePath,
    workspacePathHash: shortHash(context.workspacePath),
    uriHash: shortHash(context.uri),
    selectionHash: shortHash(context.selectedCode),
  }
}

export function logCommentStage(
  output: Pick<vscode.OutputChannel, "appendLine">,
  trace: CommentGenerationTraceContext,
  stage: string,
  fields: Record<string, unknown> = {},
) {
  const parts = [
    `trace=${trace.traceId}`,
    trace.extensionVersion ? `extVersion=${trace.extensionVersion}` : "",
    stage ? `stage=${stage}` : "",
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatFieldValue(value)}`),
  ].filter(Boolean)
  output.appendLine(`${LOG_PREFIX} ${parts.join(" ")}`)
}

export function logCommentOutcome(
  output: Pick<vscode.OutputChannel, "appendLine">,
  trace: CommentGenerationTraceContext,
  reason: CommentGenerationTerminalReason,
  detail: string,
  fields: Record<string, unknown> = {},
) {
  logCommentStage(output, trace, "outcome", {
    reason,
    detail,
    ...fields,
  })
}

export function textByteLength(input: string) {
  return new TextEncoder().encode(input).byteLength
}

export function shortHash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

export function previewHash(input: string) {
  return input.trim() ? shortHash(input) : "empty"
}

export function commentContextLogFields(context: CommentGenerationContext) {
  return {
    workspacePathHash: shortHash(context.workspacePath),
    uriHash: shortHash(context.uri),
    source: context.source,
    workspaceReviewUnitId: context.workspaceReviewUnitId ? shortHash(context.workspaceReviewUnitId) : undefined,
    workspaceReviewUnitKind: context.workspaceReviewUnitKind,
    workspaceChangeDiffHash: context.workspaceChangeDiffHash ? shortHash(context.workspaceChangeDiffHash) : undefined,
    changedLineSpans: context.changedLineSpans,
    languageId: context.languageId,
    documentVersion: context.documentVersion,
    selectionStartLine: context.selectionStartLine,
    selectionEndLine: context.selectionEndLine,
    selectionHash: shortHash(context.selectedCode),
    selectedBytes: textByteLength(context.selectedCode),
    contextBeforeBytes: textByteLength(context.contextBefore),
    contextAfterBytes: textByteLength(context.contextAfter),
    commentStyleBytes: textByteLength(context.existingCommentExamples),
    allowedAnchorCount: context.allowedInsertionAnchors.length,
    selectionIntent: context.selectionIntent,
    proposalBudget: context.proposalBudget,
    primaryAnchorPolicy: context.primaryAnchorPolicy,
    primaryAnchorLine: context.primaryAnchorLine,
    primaryAnchorKind: context.primaryAnchorKind,
    internalAnchorCount: context.internalAnchorLines.length,
  }
}

export function responsePreviewField(preview: CommentResponsePreview) {
  return preview.kind === "structured"
    ? JSON.stringify({
      proposalCount: preview.proposalCount,
      proposals: preview.proposals,
    })
    : JSON.stringify({
      preview: preview.preview,
    })
}

function formatFieldValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (typeof value === "string") return JSON.stringify(value)
  return JSON.stringify(value)
}
