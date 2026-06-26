import * as crypto from "node:crypto"

export const DOCUMENT_RAG_GLOB = "**/*.{doc,docx,xlsx,xlsm,pdf}"
export const DOCUMENT_RAG_DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/.vscode-test/**",
  "**/~$*",
]

export type DocumentRagDocument = {
  uri: string
  path: string
  kind: DocumentRagDocumentKind
  size: number
  mtime: number
  hash?: string
  indexedAt?: number
  chunkCount?: number
  skipped?: boolean
  error?: string
}

export type DocumentRagDocumentKind = "doc" | "docx" | "xlsx" | "xlsm" | "pdf"

export type DocumentRagChunk = {
  id: string
  documentUri: string
  path: string
  kind: DocumentRagDocumentKind
  section: string
  chunkKind?: string
  label?: string
  headingPath?: string[]
  sheetName?: string
  rowStart?: number
  rowEnd?: number
  cellRange?: string
  pageStart?: number
  pageEnd?: number
  startLine: number
  endLine: number
  text: string
  sourceHash: string
  updatedAt: number
}

export type DocumentRagSourceBlock = {
  kind: string
  text: string
  label?: string
  lineStart?: number
  lineEnd?: number
  headingPath?: string[]
  sheetName?: string
  rowStart?: number
  rowEnd?: number
  cellRange?: string
  pageStart?: number
  pageEnd?: number
}

export type DocumentRagSearchHit = {
  chunk: DocumentRagChunk
  score: number
}

export function isSupportedDocumentRagPath(path: string) {
  return documentRagKindFromPath(path) !== undefined
}

export function documentRagKindFromPath(path: string): DocumentRagDocumentKind | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith(".doc")) return "doc"
  if (lower.endsWith(".docx")) return "docx"
  if (lower.endsWith(".xlsx")) return "xlsx"
  if (lower.endsWith(".xlsm")) return "xlsm"
  if (lower.endsWith(".pdf")) return "pdf"
  return undefined
}

export function isDocumentRagExcludedPath(path: string, extraGlobs: string[] = []) {
  const normalized = normalizePath(path)
  const segments = normalized.split("/").filter(Boolean)
  if (segments.some((segment) => DOCUMENT_RAG_EXCLUDED_SEGMENTS.has(segment) || segment.startsWith("~$"))) return true
  return extraGlobs.some((pattern) => matchesSimpleGlob(normalized, pattern))
}

export function documentRagExcludeGlob(extraGlobs: string[] = []) {
  const patterns = [...DOCUMENT_RAG_DEFAULT_EXCLUDES, ...extraGlobs.map((item) => item.trim()).filter(Boolean)]
  return `{${patterns.join(",")}}`
}

export function createDocumentRagChunks(input: {
  document: DocumentRagDocument
  text: string
  blocks?: DocumentRagSourceBlock[]
  sourceHash: string
  chunkChars?: number
  overlapChars?: number
  maxChunks?: number
  now?: number
}): DocumentRagChunk[] {
  const chunkChars = Math.max(500, Math.floor(input.chunkChars ?? 2400))
  const overlapChars = Math.max(0, Math.min(chunkChars - 1, Math.floor(input.overlapChars ?? 300)))
  const maxChunks = Math.max(0, Math.floor(input.maxChunks ?? Number.MAX_SAFE_INTEGER))
  const text = normalizeDocumentText(input.text)
  if (!text || maxChunks === 0) return []
  const blocks = (input.blocks ?? [])
    .map((block) => ({ ...block, text: normalizeDocumentText(block.text) }))
    .filter((block) => block.text)
  if (blocks.length > 0) {
    return createStructuredDocumentRagChunks({
      document: input.document,
      blocks,
      sourceHash: input.sourceHash,
      chunkChars,
      maxChunks,
      now: input.now,
    })
  }
  const starts = lineStartOffsets(text)
  const chunks: DocumentRagChunk[] = []
  let offset = 0
  while (offset < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, offset + chunkChars)
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", end)
      const lineBreak = text.lastIndexOf("\n", end)
      const boundary = paragraphBreak > offset + Math.floor(chunkChars * 0.45)
        ? paragraphBreak + 2
        : lineBreak > offset + Math.floor(chunkChars * 0.55)
          ? lineBreak + 1
          : end
      end = Math.max(offset + 1, boundary)
    }
    const chunkText = text.slice(offset, end).trim()
    if (chunkText) {
      const startLine = lineNumberAt(starts, offset)
      const endLine = lineNumberAt(starts, Math.max(offset, end - 1))
      const section = `${input.document.kind}:${chunks.length + 1}`
      chunks.push({
        id: documentRagChunkId(input.document.uri, input.sourceHash, chunks.length),
        documentUri: input.document.uri,
        path: input.document.path,
        kind: input.document.kind,
        section,
        startLine,
        endLine,
        text: chunkText,
        sourceHash: input.sourceHash,
        updatedAt: input.now ?? Date.now(),
      })
    }
    if (end >= text.length) break
    offset = Math.max(end - overlapChars, offset + 1)
  }
  return chunks
}

function createStructuredDocumentRagChunks(input: {
  document: DocumentRagDocument
  blocks: DocumentRagSourceBlock[]
  sourceHash: string
  chunkChars: number
  maxChunks: number
  now?: number
}) {
  const chunks: DocumentRagChunk[] = []
  for (const block of input.blocks) {
    const pieces = splitStructuredBlockText(block.text, input.chunkChars)
    for (const piece of pieces) {
      if (chunks.length >= input.maxChunks) return chunks
      const baseLine = Math.max(1, Math.floor(block.lineStart ?? 1))
      const startLine = baseLine + piece.lineStartOffset
      const endLine = Math.min(
        Math.max(startLine, baseLine + piece.lineEndOffset),
        Math.max(startLine, Math.floor(block.lineEnd ?? baseLine + piece.lineEndOffset)),
      )
      chunks.push({
        id: documentRagChunkId(input.document.uri, input.sourceHash, chunks.length),
        documentUri: input.document.uri,
        path: input.document.path,
        kind: input.document.kind,
        section: block.label || `${input.document.kind}:${chunks.length + 1}`,
        chunkKind: block.kind,
        label: block.label,
        headingPath: block.headingPath?.length ? [...block.headingPath] : undefined,
        sheetName: block.sheetName,
        rowStart: block.rowStart,
        rowEnd: block.rowEnd,
        cellRange: block.cellRange,
        pageStart: block.pageStart,
        pageEnd: block.pageEnd,
        startLine,
        endLine,
        text: piece.text,
        sourceHash: input.sourceHash,
        updatedAt: input.now ?? Date.now(),
      })
    }
  }
  return chunks
}

function splitStructuredBlockText(text: string, chunkChars: number) {
  const lines = text.split("\n")
  const pieces: Array<{ text: string; lineStartOffset: number; lineEndOffset: number }> = []
  let current: string[] = []
  let currentStart = 0
  const flush = (endOffset: number) => {
    const chunk = current.join("\n").trim()
    if (chunk) pieces.push({ text: chunk, lineStartOffset: currentStart, lineEndOffset: endOffset })
    current = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.length > chunkChars) {
      if (current.length > 0) flush(index - 1)
      for (let offset = 0; offset < line.length; offset += chunkChars) {
        const chunk = line.slice(offset, offset + chunkChars).trim()
        if (chunk) pieces.push({ text: chunk, lineStartOffset: index, lineEndOffset: index })
      }
      currentStart = index + 1
      continue
    }
    const candidate = current.length === 0 ? line : `${current.join("\n")}\n${line}`
    if (current.length > 0 && candidate.length > chunkChars) {
      flush(index - 1)
      currentStart = index
      current = [line]
      continue
    }
    if (current.length === 0) currentStart = index
    current.push(line)
  }
  if (current.length > 0) flush(lines.length - 1)
  return pieces
}

export function searchDocumentRagVectors(input: {
  chunks: DocumentRagChunk[]
  vectors: number[][]
  queryVector: number[]
  topK: number
}): DocumentRagSearchHit[] {
  const topK = Math.max(0, Math.floor(input.topK))
  if (topK === 0 || input.chunks.length === 0 || input.vectors.length === 0) return []
  const query = normalizeVector(input.queryVector)
  return input.chunks
    .map((chunk, index) => ({ chunk, score: cosine(query, input.vectors[index] ?? []) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) || left.chunk.startLine - right.chunk.startLine)
    .slice(0, topK)
}

export function normalizeDocumentRagVector(vector: number[]) {
  return normalizeVector(vector)
}

export function hashDocumentBytes(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

export function encodeDocumentRagVectors(vectors: number[][], dimension: number) {
  const array = new Float32Array(vectors.length * dimension)
  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index]
    if (vector.length !== dimension) throw new Error("Cannot encode Document RAG vectors with inconsistent dimensions.")
    array.set(vector, index * dimension)
  }
  return new Uint8Array(array.buffer)
}

export function decodeDocumentRagVectors(bytes: Uint8Array, dimension: number) {
  if (dimension <= 0) return []
  const array = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const rows = Math.floor(array.length / dimension)
  const vectors: number[][] = []
  for (let row = 0; row < rows; row++) {
    vectors.push(Array.from(array.slice(row * dimension, row * dimension + dimension)))
  }
  return vectors
}

function documentRagChunkId(uri: string, sourceHash: string, index: number) {
  return crypto.createHash("sha1").update(`${uri}\0${sourceHash}\0${index}`).digest("hex")
}

function normalizeDocumentText(text: string) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim()
}

function lineStartOffsets(text: string) {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1)
  }
  return starts
}

function lineNumberAt(starts: number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (starts[mid] <= offset) low = mid + 1
    else high = mid - 1
  }
  return Math.max(1, high + 1)
}

function normalizeVector(vector: number[]) {
  const values = vector.map(Number)
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!norm || !Number.isFinite(norm)) throw new Error("Cannot normalize an empty or invalid Document RAG vector.")
  return values.map((value) => value / norm)
}

function cosine(left: number[], right: number[]) {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY
  let dot = 0
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index]
  return dot
}

function matchesSimpleGlob(path: string, pattern: string) {
  const value = normalizePath(pattern).trim()
  if (!value) return false
  if (value.includes("*")) return globToRegExp(value).test(path)
  return path === value || path.startsWith(`${value}/`) || path.includes(`/${value}/`)
}

function globToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
  return new RegExp(`^${escaped}$`)
}

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
}

const DOCUMENT_RAG_EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", "out", "build", ".vscode-test"])
