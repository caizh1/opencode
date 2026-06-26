import { splitTextByRuleAnchors } from "./RuleAnchors"
import type { DocxReadBlock, ReferenceChunk, ReferenceDocument, ReferenceDocRole, SourceLocation } from "./types"

const MAX_CHUNK_BYTES = 12 * 1024

export class ReferenceDocExtractor {
  classifyDocuments(documents: Array<Partial<ReferenceDocument> & { id: string; read: ReferenceDocument["read"] }>): ReferenceDocument[] {
    return documents.map((doc, index) => ({
      ...doc,
      role: roleFromOrigin(doc.sourceOrigin) ?? doc.role ?? "unknown",
      sourceOrigin: doc.sourceOrigin ?? "unknown",
      mentionIndex: doc.mentionIndex ?? index,
    }))
  }

  chunks(document: ReferenceDocument): ReferenceChunk[] {
    const chunks: ReferenceChunk[] = []
    let current: DocxReadBlock[] = []
    let currentHeading: string[] = []

    const flush = () => {
      if (current.length === 0) return
      const text = current.map((block) => block.text).join("\n\n").trim()
      if (!text) {
        current = []
        return
      }
      const segments = splitTextByRuleAnchors(text)
      if (segments.length > 0) {
        for (const segment of segments) {
          chunks.push(chunkFor(document, chunks.length + 1, currentHeading, segment.text, current.map((block) => block.sourceLocation), segment.sourceRuleAnchor))
        }
      } else {
        chunks.push(chunkFor(document, chunks.length + 1, currentHeading, text, current.map((block) => block.sourceLocation)))
      }
      current = []
    }

    for (const block of document.read.blocks) {
      if (block.kind === "heading" && block.level === 1) flush()
      if (block.kind === "heading" && block.headingPath.length > 0) currentHeading = block.headingPath
      current.push(block)
      if (Buffer.byteLength(current.map((item) => item.text).join("\n\n"), "utf8") >= MAX_CHUNK_BYTES) flush()
    }
    flush()
    return chunks
  }
}

function chunkFor(
  document: ReferenceDocument,
  index: number,
  headingPath: string[],
  text: string,
  sourceLocations: SourceLocation[],
  sourceRuleAnchor?: string,
): ReferenceChunk {
  return {
    id: `${document.id}-chunk-${index}`,
    sourceId: document.id,
    sourcePath: document.read.metadata.path,
    role: document.role,
    sourceOrigin: document.sourceOrigin,
    sourceRuleAnchor,
    headingPath,
    text,
    sourceLocations: sourceLocations.map((location) => sourceRuleAnchor ? { ...location, sourceRuleAnchor } : location),
  }
}

function roleFromOrigin(origin: ReferenceDocument["sourceOrigin"] | undefined): ReferenceDocRole | undefined {
  if (origin === "internal_company") return "internal"
  if (origin === "external_public" || origin === "external_licensed") return "external"
  return undefined
}

export function roleLabel(role: ReferenceDocRole) {
  if (role === "internal") return "公司内部规范"
  if (role === "external") return "外部参考规范"
  return "未分类资料"
}
