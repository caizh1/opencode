import { DocxRenderQualityGate } from "../docAgent/DocxRenderQualityGate"
import { DocxFileStore } from "../docAgent/DocxFileStore"
import { WordDocBuilder } from "../docAgent/WordDocBuilder"
import { WordDocSpecValidator } from "../docAgent/WordDocSpecValidator"
import { renderWordDocument } from "../docAgent/WordRenderQualityGate"
import { resolveWordDesignPreset } from "../docAgent/themes/WordDesignPresets"
import type { DocumentSection, FigureSpec, GeneratedDocumentResult, WordDocSpec } from "../docAgent/types"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

export async function createWordDocument(input: {
  spec: WordDocSpec
  filename?: string
  remoteEndpoint?: string
}): Promise<GeneratedDocumentResult> {
  const specIssues = new WordDocSpecValidator().validate(input.spec)
  const specErrors = specIssues.filter((issue) => issue.severity === "error").map((issue) => issue.message)
  if (specErrors.length > 0) {
    throw new Error(`WordDocSpec validation failed: ${specErrors.join("; ")}`)
  }
  const spec = await hydrateFigureImagePaths(input.spec)
  const builder = new WordDocBuilder()
  const bytes = await builder.build(spec)
  const structureIssues = await new DocxRenderQualityGate().check(bytes)
  const errors = structureIssues.filter((issue) => issue.severity === "error").map((issue) => issue.message)
  const warnings = structureIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message)
  if (errors.length > 0) {
    throw new Error(`Generated DOCX failed render quality gate: ${errors.join("; ")}`)
  }
  const stored = await new DocxFileStore().write({
    filename: input.filename || spec.metadata.title || "generated-document",
    bytes,
  })
  const renderCheckResult = await renderWordDocument({
    docxPath: stored.absolutePath,
    bytes,
    workspaceRoot: workspaceRootFromStoredPath(stored.absolutePath),
    artifactNameBase: input.filename || spec.metadata.title || "generated-document",
    structureIssues,
    timeoutMs: 60_000,
    remoteEndpoint: input.remoteEndpoint,
  })
  const allWarnings = normalizeCreateWordDocumentWarnings([
    ...specIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
    ...warnings,
    ...renderCheckResult.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
  ], spec)
  const uniqueWarnings = [...new Set(allWarnings)]
  return {
    ...stored,
    title: spec.metadata.title,
    designPreset: resolveWordDesignPreset(spec.layout),
    sourceCount: Array.isArray(spec.sources) ? spec.sources.length : 0,
    warningCount: uniqueWarnings.length,
    warnings: uniqueWarnings,
    errors: [],
    structureIssues: [...specIssues, ...structureIssues],
    renderCheckResult,
  }
}

function normalizeCreateWordDocumentWarnings(warnings: string[], spec: WordDocSpec) {
  const sourceBacked = Array.isArray(spec.sources) && spec.sources.length > 0
  return warnings.filter((message) => {
    if (!message) return false
    if (!sourceBacked && isReferencesWarning(message)) return false
    if (sourceBacked && /acceptable for non-source-backed documents/i.test(message)) return false
    return true
  })
}

function isReferencesWarning(message: string) {
  return /References section/i.test(message) || /参考资料/.test(message)
}

function workspaceRootFromStoredPath(absolutePath: string) {
  return path.dirname(path.dirname(path.dirname(absolutePath)))
}

async function hydrateFigureImagePaths(spec: WordDocSpec): Promise<WordDocSpec> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
  return {
    ...spec,
    sections: await hydrateSectionFigureImagePaths(spec.sections, workspaceRoot),
    appendices: spec.appendices ? await hydrateSectionFigureImagePaths(spec.appendices, workspaceRoot) : undefined,
  }
}

async function hydrateSectionFigureImagePaths(sections: DocumentSection[], workspaceRoot: string): Promise<DocumentSection[]> {
  const hydrated: DocumentSection[] = []
  for (const section of sections) {
    hydrated.push({
      ...section,
      figures: section.figures ? await Promise.all(section.figures.map((figure) => hydrateFigureImagePath(figure, workspaceRoot))) : undefined,
    })
  }
  return hydrated
}

async function hydrateFigureImagePath(figure: FigureSpec, workspaceRoot: string): Promise<FigureSpec> {
  if (figure.image.bytes?.length || figure.image.base64?.trim()) return figure
  const imagePath = figure.image.path?.trim() || figure.image.artifactPath?.trim()
  if (!imagePath) return figure
  const target = path.isAbsolute(imagePath) ? imagePath : path.join(workspaceRoot, imagePath)
  const bytes = await readFile(target)
  return {
    ...figure,
    image: {
      ...figure.image,
      bytes: Uint8Array.from(bytes),
    },
  }
}
