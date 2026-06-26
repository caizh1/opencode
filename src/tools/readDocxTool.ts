import { parseSupportedDocument } from "../document-parser"
import type { DocxReadBlock, DocxReadResult } from "../docAgent/types"

const DOCX_PREVIEW_BYTES = 48 * 1024

export async function readDocx(input: {
  path: string
  bytes: Uint8Array
  maxBytes?: number
}): Promise<DocxReadResult> {
  if (!input.path.toLowerCase().endsWith(".docx")) {
    throw new Error(`read_docx only supports .docx files: ${input.path}`)
  }
  const parsed = await parseSupportedDocument({
    path: input.path,
    bytes: input.bytes,
    maxBytes: input.maxBytes ?? 512 * 1024,
  })
  if (!parsed || parsed.kind !== "docx") throw new Error(`Unable to parse DOCX: ${input.path}`)
  const semanticBlocks = parsed.blocks
    .filter((block) => block.kind === "heading" || block.kind === "paragraph" || block.kind === "list" || block.kind === "table" || block.kind === "note" || block.kind === "text")
  const sectionCounters = new Map<string, number>()
  const blocks: DocxReadBlock[] = semanticBlocks
    .map((block, index) => {
      const headingPath = block.headingPath ?? []
      const sourceBlockId = `${safeId(input.path)}-block-${index + 1}`
      const sectionKey = headingPath.join("\u0000")
      const sectionBlockIndex = (sectionCounters.get(sectionKey) ?? 0) + 1
      sectionCounters.set(sectionKey, sectionBlockIndex)
      return {
        id: sourceBlockId,
        sourceBlockId,
        blockIndex: index + 1,
        sectionBlockIndex,
        kind: block.kind as DocxReadBlock["kind"],
        text: block.text,
        label: block.label,
        level: headingLevel(block.label),
        headingPath,
        neighborTextPreview: {
          previous: previewText(semanticBlocks[index - 1]?.text),
          next: previewText(semanticBlocks[index + 1]?.text),
        },
        sourceLocation: {
          path: input.path,
          lineStart: block.lineStart,
          lineEnd: block.lineEnd,
          headingPath,
          sourceBlockId,
          blockIndex: index + 1,
          sectionBlockIndex,
        },
      }
    })
  return {
    metadata: {
      path: input.path,
      title: documentTitle(input.path, blocks),
      byteSize: input.bytes.length,
      truncated: parsed.truncated,
      readWarnings: parsed.truncated ? ["DOCX extracted text was truncated by the read_docx byte budget."] : [],
    },
    blocks,
    textPreview: limitBytes(parsed.text, DOCX_PREVIEW_BYTES),
  }
}

function headingLevel(label: string | undefined): 1 | 2 | 3 | undefined {
  const match = label?.match(/^Heading\s+([1-6])/i)
  if (!match) return undefined
  const level = Number(match[1])
  if (level <= 1) return 1
  if (level === 2) return 2
  return 3
}

function documentTitle(path: string, blocks: DocxReadBlock[]) {
  const heading = blocks.find((block) => block.kind === "heading" && block.text.trim())
  if (heading) return heading.text.trim().slice(0, 120)
  return path.split(/[\\/]/).pop()?.replace(/\.docx$/i, "") || "Word document"
}

function safeId(input: string) {
  return input.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "docx"
}

function limitBytes(input: string, maxBytes: number) {
  const bytes = Buffer.from(input, "utf8")
  if (bytes.length <= maxBytes) return input
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`
}

function previewText(input: string | undefined) {
  const text = input?.replace(/\s+/g, " ").trim()
  return text ? text.slice(0, 220) : undefined
}
