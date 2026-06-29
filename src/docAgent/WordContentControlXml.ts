export type ContentControlKind = "plainText" | "checkbox" | "dropdown" | "date" | "unknown"

export type ContentControlFillUnsupportedReason =
  | "nested-content-control"
  | "rich-content-control"
  | "unsupported-content-control"
  | "complex-content-control"

export type SdtXmlBlock = {
  xml: string
  start: number
  end: number
  index: number
  nestedControlCount: number
}

export type ContentControlFillAnalysis = {
  fillSupported: boolean
  fillUnsupportedReason?: ContentControlFillUnsupportedReason
  hasRichContent: boolean
}

export function topLevelSdtXmlBlocks(documentXml: string): SdtXmlBlock[] {
  const blocks: SdtXmlBlock[] = []
  const tagPattern = /<\/w:sdt>|<w:sdt\b[^>]*>/g
  let depth = 0
  let start = -1
  let nestedControlCount = 0
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(documentXml))) {
    const tag = match[0]
    if (tag.startsWith("</")) {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && start >= 0) {
        blocks.push({
          xml: documentXml.slice(start, match.index + tag.length),
          start,
          end: match.index + tag.length,
          index: blocks.length + 1,
          nestedControlCount,
        })
        start = -1
        nestedControlCount = 0
      }
      continue
    }
    if (depth === 0) {
      start = match.index
      nestedControlCount = 0
    } else {
      nestedControlCount += 1
    }
    depth += 1
  }
  return blocks
}

export function contentControlKindFromXml(xml: string): ContentControlKind {
  if (/<w14:checkbox\b/.test(xml)) return "checkbox"
  if (/<w:dropDownList\b/.test(xml)) return "dropdown"
  if (/<w:date\b/.test(xml)) return "date"
  if (/<w:text\b/.test(xml)) return "plainText"
  return "unknown"
}

export function analyzeContentControlFillSupport(xml: string, kind: ContentControlKind, nestedControlCount: number): ContentControlFillAnalysis {
  const hasRichContent = /<w:richText\b/.test(xml)
  if (nestedControlCount > 0) {
    return { fillSupported: false, fillUnsupportedReason: "nested-content-control", hasRichContent }
  }
  const contentXml = xml.match(/<w:sdtContent\b[^>]*>([\s\S]*?)<\/w:sdtContent>/)?.[1] ?? ""
  if (/<w:sdt\b/.test(contentXml)) {
    return { fillSupported: false, fillUnsupportedReason: "nested-content-control", hasRichContent }
  }
  if (hasRichContent) {
    return { fillSupported: false, fillUnsupportedReason: "rich-content-control", hasRichContent: true }
  }
  if (kind === "unknown") {
    return { fillSupported: false, fillUnsupportedReason: "unsupported-content-control", hasRichContent }
  }
  if (/<w:(?:tbl|drawing|pict|object|altChunk)\b/.test(contentXml)) {
    return { fillSupported: false, fillUnsupportedReason: "complex-content-control", hasRichContent }
  }
  return { fillSupported: true, hasRichContent }
}
