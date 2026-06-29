import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import type {
  SourceLocation,
  WordDocumentInspection,
  WordDocumentLocator,
  WordDocumentCommentInspection,
  WordDocumentCaptionInspection,
  WordDocumentContentControlInspection,
  WordDocumentFieldInspection,
  WordDocumentHyperlinkInspection,
  WordDocumentImageInspection,
  WordDocumentListInspection,
  WordDocumentNoteInspection,
  WordDocumentParagraphInspection,
  WordDocumentProtectionInspection,
  WordDocumentSectionInspection,
  WordDocumentStyleInspection,
  WordDocumentTableInspection,
  WordDocumentWatermarkInspection,
} from "./types"
import {
  analyzeContentControlFillSupport,
  contentControlKindFromXml,
  topLevelSdtXmlBlocks,
} from "./WordContentControlXml"

const nodeRequire = createRequire(__filename)

type JsZipModule = typeof import("jszip")
type ZipEntry = {
  dir?: boolean
  async(type: "string"): Promise<string>
}
type ZipArchive = {
  file(path: string): ZipEntry | null
  file(path: string, data: string | Uint8Array): void
  generateAsync(input: { type: "nodebuffer"; compression: "DEFLATE" }): Promise<Buffer>
  files: Record<string, ZipEntry>
}

type MutableListInspection = Omit<WordDocumentListInspection, "normalizedHash"> & {
  normalizedHash?: string
  lastBlockIndex: number
  levelSet: Set<number>
}

type SectionHeaderFooterReference = {
  type?: string
  relId?: string
}

type WatermarkCandidate = {
  offset: number
  kind: WordDocumentWatermarkInspection["kind"]
  text: string
  relId?: string
  target?: string
  targetMode?: string
  relationshipMode?: WordDocumentWatermarkInspection["relationshipMode"]
  mediaPath?: string
  mediaExtension?: string
  contentType?: string
  mediaExists?: boolean
}

export type WordTopLevelElement = {
  kind: "paragraph" | "table"
  xml: string
  blockIndex: number
  paragraphIndex?: number
  tableIndex?: number
  blockId: string
}

export class WordDocumentInspector {
  async inspect(input: { path: string; bytes: Uint8Array }): Promise<WordDocumentInspection> {
    const zip = await loadDocxZip(input.bytes)
    const documentXml = await zip.file("word/document.xml")?.async("string")
    if (!documentXml) throw new Error(`inspect_word_document failed: ${input.path} is missing word/document.xml`)
    const elements = parseTopLevelElements(documentXml)
    const paragraphs: WordDocumentParagraphInspection[] = []
    const tables: WordDocumentTableInspection[] = []
    const captions: WordDocumentCaptionInspection[] = []
    const lists: MutableListInspection[] = []
    const locators: WordDocumentLocator[] = []
    const headingPath: string[] = []
    const listKindByNumId = await listKindByNumIdFrom(zip)
    let activeList: MutableListInspection | undefined
    const comments = await extractComments(zip, input.path)
    const contentControls = extractContentControls(documentXml, input.path)
    const watermarks = await extractWatermarks(zip, input.path)
    const notes = await extractNotes(zip, input.path)
    const images = await extractImages(zip, input.path)
    const settingsXml = await zip.file("word/settings.xml")?.async("string").catch(() => "")
    const sections = extractSections(documentXml, input.path, settingsXml ?? "")
    const fields = await extractFields(zip, input.path)
    const styles = await extractStyles(zip, input.path)
    const hyperlinks = await extractHyperlinks(zip, input.path)
    const protection = await extractDocumentProtection(zip, input.path)
    for (const element of elements) {
      if (element.kind === "paragraph") {
        const text = xmlTextFrom(element.xml)
        const styleId = paragraphStyleId(element.xml)
        const headingLevel = headingLevelFromStyle(styleId)
        if (headingLevel && text.trim()) {
          headingPath[headingLevel - 1] = text.trim()
          headingPath.length = headingLevel
        }
        const location = makeSourceLocation(input.path, element.blockIndex, [...headingPath], element.blockId)
        const locator: WordDocumentLocator = {
          kind: "paragraph",
          blockId: element.blockId,
          headingPath: [...headingPath],
          sourceLocation: location,
          normalizedHash: normalizedHash(text),
        }
        const listInfo = paragraphListInfo(element.xml, listKindByNumId)
        if (listInfo) {
          const sameList = activeList
            && activeList.lastBlockIndex === element.blockIndex - 1
            && (activeList.numId === listInfo.numId || (activeList.kind === "checklist" && listInfo.kind === "checklist"))
          if (!sameList) {
            const listIndex = lists.length + 1
            const listBlockId = `list-${listIndex}`
            const listLocation = makeSourceLocation(input.path, element.blockIndex, [...headingPath], listBlockId)
            const listLocator: WordDocumentLocator = {
              kind: "list",
              blockId: listBlockId,
              listIndex,
              listNumId: listInfo.numId,
              headingPath: [...headingPath],
              sourceLocation: listLocation,
            }
            activeList = {
              id: listBlockId,
              blockId: listBlockId,
              listIndex,
              numId: listInfo.numId,
              kind: listInfo.kind,
              levelCount: 0,
              itemCount: 0,
              items: [],
              headingPath: [...headingPath],
              sourceLocation: listLocation,
              locator: listLocator,
              lastBlockIndex: element.blockIndex,
              levelSet: new Set<number>(),
            }
            lists.push(activeList)
          }
          const currentList = activeList
          if (!currentList) throw new Error("inspect_word_document internal error: active list missing after list paragraph detection")
          currentList.lastBlockIndex = element.blockIndex
          currentList.levelSet.add(listInfo.level)
          currentList.itemCount += 1
          currentList.levelCount = currentList.levelSet.size
          currentList.items.push({
            paragraphId: element.blockId,
            paragraphIndex: element.paragraphIndex ?? paragraphs.length + 1,
            blockIndex: element.blockIndex,
            text,
            level: listInfo.level,
          })
          locator.listIndex = currentList.listIndex
          locator.listNumId = listInfo.numId
          locator.listLevel = listInfo.level
        } else {
          activeList = undefined
        }
        paragraphs.push({
          id: element.blockId,
          blockId: element.blockId,
          paragraphIndex: element.paragraphIndex ?? paragraphs.length + 1,
          blockIndex: element.blockIndex,
          text,
          styleId,
          headingLevel,
          list: listInfo ? {
            listIndex: activeList?.listIndex,
            numId: listInfo.numId,
            level: listInfo.level,
            kind: listInfo.kind,
          } : undefined,
          headingPath: [...headingPath],
          sourceLocation: location,
          normalizedHash: locator.normalizedHash!,
          locator,
        })
        locators.push(locator)
        const captionInfo = captionInfoFromParagraph(element.xml)
        if (captionInfo) {
          const captionIndex = captions.length + 1
          const captionBlockId = `caption-${captionIndex}`
          const captionLocation = makeSourceLocation(input.path, element.blockIndex, [...headingPath], captionBlockId)
          const captionHash = normalizedHash([
            captionInfo.captionKind,
            captionInfo.label ?? "",
            captionInfo.number ?? "",
            captionInfo.text,
            captionInfo.fieldInstruction ?? "",
            captionInfo.bookmark ?? "",
          ].join("\n"))
          const captionLocator: WordDocumentLocator = {
            kind: "caption",
            blockId: captionBlockId,
            captionIndex,
            captionKind: captionInfo.captionKind,
            captionLabel: captionInfo.label,
            headingPath: [...headingPath],
            sourceLocation: captionLocation,
            normalizedHash: captionHash,
          }
          captions.push({
            id: captionBlockId,
            blockId: captionBlockId,
            captionIndex,
            captionKind: captionInfo.captionKind,
            label: captionInfo.label,
            number: captionInfo.number,
            text: captionInfo.text,
            fullText: captionInfo.fullText,
            fieldInstruction: captionInfo.fieldInstruction,
            bookmark: captionInfo.bookmark,
            paragraphId: element.blockId,
            paragraphIndex: element.paragraphIndex ?? paragraphs.length,
            blockIndex: element.blockIndex,
            headingPath: [...headingPath],
            sourceLocation: captionLocation,
            normalizedHash: captionHash,
            locator: captionLocator,
          })
          locators.push(captionLocator)
        }
        continue
      }
      activeList = undefined
      const tableIndex = element.tableIndex ?? tables.length + 1
      const rows = tableRows(element.xml)
      const location = makeSourceLocation(input.path, element.blockIndex, [...headingPath], element.blockId)
      const locator: WordDocumentLocator = {
        kind: "table",
        blockId: element.blockId,
        tableIndex,
        headingPath: [...headingPath],
        sourceLocation: location,
        normalizedHash: normalizedHash(rows.flat().join("\n")),
      }
      tables.push({
        id: element.blockId,
        blockId: element.blockId,
        tableIndex,
        blockIndex: element.blockIndex,
        headingPath: [...headingPath],
        rows,
        sourceLocation: location,
        normalizedHash: locator.normalizedHash!,
        locator,
      })
      locators.push(locator)
      rows.forEach((row, rowIndex) => {
        row.forEach((cell, cellIndex) => {
          locators.push({
            kind: "tableCell",
            blockId: `${element.blockId}-r${rowIndex + 1}-c${cellIndex + 1}`,
            tableIndex,
            rowIndex,
            cellIndex,
            headingPath: [...headingPath],
            sourceLocation: location,
            normalizedHash: normalizedHash(cell),
          })
        })
      })
    }
    const documentEndLocator: WordDocumentLocator = {
      kind: "documentEnd",
      blockId: "document-end",
      sourceLocation: { path: input.path, sourceBlockId: "document-end", blockIndex: elements.length + 1 },
    }
    locators.push(documentEndLocator)
    locators.push(...comments.map((comment) => comment.locator))
    locators.push(...contentControls.map((control) => control.locator))
    locators.push(...watermarks.map((watermark) => watermark.locator))
    locators.push(...notes.map((note) => note.locator))
    locators.push(...images.map((image) => image.locator))
    locators.push(...sections.map((section) => section.locator))
    locators.push(...fields.map((field) => field.locator))
    locators.push(...styles.map((style) => style.locator))
    locators.push(...hyperlinks.map((link) => link.locator))
    if (protection) locators.push(protection.locator)
    for (const list of lists) {
      list.normalizedHash = normalizedHash([list.numId, list.kind ?? "", ...list.items.map((item) => `${item.level}:${item.text}`)].join("\n"))
      list.locator.normalizedHash = list.normalizedHash
      locators.push(list.locator)
    }
    const fieldTypeCounts = fieldTypeCountsFrom(fields)
    const finalizedLists = lists.map(({ lastBlockIndex: _lastBlockIndex, levelSet: _levelSet, normalizedHash: hash, ...list }) => ({
      ...list,
      normalizedHash: hash ?? normalizedHash([list.numId, ...list.items.map((item) => item.text)].join("\n")),
    }))
    const trackedChangeTypes = trackedChangeTypeCounts(documentXml)
    const trackedChangeWarnings = advancedTrackedChangeWarnings(trackedChangeTypes)
    return {
      metadata: {
        path: input.path,
        title: titleFrom(paragraphs, input.path),
        byteSize: input.bytes.length,
      },
      paragraphs,
      tables,
      lists: finalizedLists,
      comments,
      contentControls,
      watermarks,
      notes,
      images,
      captions,
      sections,
      fields,
      styles,
      hyperlinks,
      protection,
      locators,
      documentEndLocator,
      summary: {
        paragraphCount: paragraphs.length,
        tableCount: tables.length,
        listCount: finalizedLists.length,
        listItemCount: finalizedLists.reduce((count, list) => count + list.itemCount, 0),
        commentCount: comments.length,
        contentControlCount: contentControls.length,
        watermarkCount: watermarks.length,
        noteCount: notes.length,
        footnoteCount: notes.filter((note) => note.noteKind === "footnote").length,
        endnoteCount: notes.filter((note) => note.noteKind === "endnote").length,
        imageCount: images.length,
        captionCount: captions.length,
        sectionCount: sections.length,
        fieldCount: fields.length,
        fieldTypeCounts,
        styleCount: styles.length,
        hyperlinkCount: hyperlinks.length,
        hasProtection: Boolean(protection),
        protectionMode: protection?.mode ?? "off",
        trackedChangeCount: trackedChangeCount(trackedChangeTypes),
        trackedChangeTypeCounts: trackedChangeTypes,
        advancedTrackedChangeWarnings: trackedChangeWarnings,
        headingCount: paragraphs.filter((item) => item.headingLevel).length,
        hasHeader: Boolean(zip.file("word/header1.xml")),
        hasFooter: Boolean(zip.file("word/footer1.xml")),
        hasStyles: Boolean(zip.file("word/styles.xml")),
        hasTocPlaceholder: /目录占位|更新目录域|TOC_PLACEHOLDER/i.test(documentXml),
      },
      warnings: trackedChangeWarnings,
    }
  }
}

function captionInfoFromParagraph(paragraphXml: string) {
  const styleId = paragraphStyleId(paragraphXml)
  const fieldInstruction = normalizeFieldInstruction(fieldInstrTextFrom(paragraphXml))
  const seqMatch = fieldInstruction.match(/\bSEQ\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)
  const isCaptionStyle = styleId?.replace(/\s+/g, "").toLowerCase() === "caption"
  if (!seqMatch && !isCaptionStyle) return undefined
  const sequenceLabel = seqMatch?.[1]
  const number = complexFieldCachedText(paragraphXml)
  const fullText = xmlTextFrom(paragraphXml).trim()
  const visibleLabel = captionVisibleLabel(fullText, number) ?? sequenceLabel
  const label = visibleLabel || sequenceLabel
  const text = captionBodyText(fullText, label, number)
  const bookmark = paragraphXml.match(/<w:bookmarkStart\b[^>]*>/)?.[0]
  const captionKind = captionKindFrom(label ?? sequenceLabel, sequenceLabel)
  return {
    captionKind,
    label,
    number,
    text,
    fullText,
    fieldInstruction: seqMatch ? fieldInstruction : undefined,
    bookmark: bookmark ? xmlAttrValue(bookmark, "name") : undefined,
  }
}

function captionVisibleLabel(fullText: string, number: string | undefined) {
  if (!number) return undefined
  const index = fullText.indexOf(number)
  if (index <= 0) return undefined
  const label = fullText.slice(0, index).trim()
  return label || undefined
}

function captionBodyText(fullText: string, label: string | undefined, number: string | undefined) {
  let text = fullText.trim()
  if (label && number) {
    const prefix = new RegExp(`^\\s*${escapeRegExp(label)}\\s+${escapeRegExp(number)}\\s*[:：]?\\s*`)
    text = text.replace(prefix, "")
  } else if (label) {
    const prefix = new RegExp(`^\\s*${escapeRegExp(label)}\\s*[:：]?\\s*`)
    text = text.replace(prefix, "")
  } else {
    text = text.replace(/^.*?[:：]\s*/, "")
  }
  return text.trim()
}

function captionKindFrom(label: string | undefined, sequenceLabel: string | undefined): "figure" | "table" | "unknown" {
  const text = [label, sequenceLabel].filter(Boolean).join(" ").toLowerCase()
  if (/\b(table|tbl)\b|表/.test(text)) return "table"
  if (/\b(figure|fig)\b|图/.test(text)) return "figure"
  return "unknown"
}

async function extractStyles(zip: ZipArchive, inputPath: string): Promise<WordDocumentStyleInspection[]> {
  const stylesXml = await zip.file("word/styles.xml")?.async("string").catch(() => "")
  if (!stylesXml) return []
  const usage = await styleUsageById(zip)
  const styles: WordDocumentStyleInspection[] = []
  let styleIndex = 0
  for (const match of stylesXml.matchAll(/<w:style\b[\s\S]*?<\/w:style>/g)) {
    const styleXml = match[0]
    const startTag = styleXml.match(/<w:style\b[^>]*>/)?.[0] ?? ""
    const styleId = xmlAttrValue(startTag, "styleId")
    if (!styleId) continue
    styleIndex += 1
    const blockId = `style-${styleIndex}`
    const type = xmlAttrValue(startTag, "type")
    const nameTag = styleXml.match(/<w:name\b[^>]*\/?>/)?.[0]
    const basedOnTag = styleXml.match(/<w:basedOn\b[^>]*\/?>/)?.[0]
    const name = nameTag ? xmlAttrValue(nameTag, "val") : undefined
    const basedOn = basedOnTag ? xmlAttrValue(basedOnTag, "val") : undefined
    const location = makeSourceLocation(inputPath, styleIndex, ["word/styles.xml"], blockId)
    const styleUsage = usage.get(styleId)
    const normalized = normalizedHash([styleId, type, name, basedOn, styleUsage?.paragraph ?? 0, styleUsage?.run ?? 0].filter((item) => item !== undefined && item !== "").join("\n"))
    const locator: WordDocumentLocator = {
      kind: "style",
      blockId,
      styleIndex,
      styleId,
      sourceLocation: location,
      normalizedHash: normalized,
    }
    styles.push({
      id: blockId,
      blockId,
      styleIndex,
      part: "word/styles.xml",
      styleId,
      type,
      name,
      basedOn,
      isDefault: xmlAttrValue(startTag, "default") === "1",
      paragraphUseCount: styleUsage?.paragraph ?? 0,
      runUseCount: styleUsage?.run ?? 0,
      sourceLocation: location,
      normalizedHash: normalized,
      locator,
    })
  }
  return styles
}

async function listKindByNumIdFrom(zip: ZipArchive) {
  const numberingXml = await zip.file("word/numbering.xml")?.async("string").catch(() => "")
  return listKindByNumIdFromNumberingXml(numberingXml ?? "")
}

export function listKindByNumIdFromNumberingXml(numberingXml: string) {
  const kinds = new Map<string, "bullet" | "numbered" | "checklist">()
  if (!numberingXml) return kinds
  const abstractKinds = new Map<string, "bullet" | "numbered" | "checklist">()
  for (const match of numberingXml.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)) {
    const abstractXml = match[0]
    const startTag = abstractXml.match(/<w:abstractNum\b[^>]*>/)?.[0] ?? ""
    const abstractNumId = xmlAttrValue(startTag, "abstractNumId")
    if (!abstractNumId) continue
    const formats = (abstractXml.match(/<w:numFmt\b[^>]*\/?>/g) ?? []).map((tag) => xmlAttrValue(tag, "val") ?? "")
    const levelTexts = (abstractXml.match(/<w:lvlText\b[^>]*\/?>/g) ?? []).map((tag) => xmlAttrValue(tag, "val") ?? "")
    if (levelTexts.some((text) => /[☐☑☒□■✓✔]/.test(text))) abstractKinds.set(abstractNumId, "checklist")
    else if (formats.some((format) => format && format !== "bullet")) abstractKinds.set(abstractNumId, "numbered")
    else abstractKinds.set(abstractNumId, "bullet")
  }
  for (const match of numberingXml.matchAll(/<w:num\b[\s\S]*?<\/w:num>/g)) {
    const numXml = match[0]
    const startTag = numXml.match(/<w:num\b[^>]*>/)?.[0] ?? ""
    const numId = xmlAttrValue(startTag, "numId")
    const abstractTag = numXml.match(/<w:abstractNumId\b[^>]*\/?>/)?.[0] ?? ""
    const abstractNumId = xmlAttrValue(abstractTag, "val")
    if (numId && abstractNumId && abstractKinds.has(abstractNumId)) kinds.set(numId, abstractKinds.get(abstractNumId)!)
  }
  return kinds
}

export function paragraphListInfo(paragraphXml: string, kindByNumId: Map<string, "bullet" | "numbered" | "checklist">) {
  const numPr = paragraphXml.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/)?.[0]
  if (!numPr) return undefined
  const numIdTag = numPr.match(/<w:numId\b[^>]*\/?>/)?.[0] ?? ""
  const numId = xmlAttrValue(numIdTag, "val")
  if (!numId) return undefined
  const ilvlTag = numPr.match(/<w:ilvl\b[^>]*\/?>/)?.[0] ?? ""
  const level = Math.max(0, numberAttrValue(ilvlTag, "val") ?? 0)
  return {
    numId,
    level,
    kind: kindByNumId.get(numId),
  }
}

async function styleUsageById(zip: ZipArchive) {
  const usage = new Map<string, { paragraph: number; run: number }>()
  for (const part of fieldPartNames(zip)) {
    const xml = await zip.file(part)?.async("string").catch(() => "")
    if (!xml) continue
    for (const paragraph of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
      const styleId = paragraphStyleId(paragraph)
      if (styleId) {
        const item = usage.get(styleId) ?? { paragraph: 0, run: 0 }
        item.paragraph += 1
        usage.set(styleId, item)
      }
      for (const runStyleTag of paragraph.match(/<w:rStyle\b[^>]*\/?>/g) ?? []) {
        const runStyleId = xmlAttrValue(runStyleTag, "val")
        if (!runStyleId) continue
        const item = usage.get(runStyleId) ?? { paragraph: 0, run: 0 }
        item.run += 1
        usage.set(runStyleId, item)
      }
    }
  }
  return usage
}

async function extractFields(zip: ZipArchive, inputPath: string): Promise<WordDocumentFieldInspection[]> {
  const fields: WordDocumentFieldInspection[] = []
  let fieldIndex = 0
  for (const part of fieldPartNames(zip)) {
    const xml = await zip.file(part)?.async("string").catch(() => "")
    if (!xml) continue
    const candidates: Array<{ offset: number; fieldKind: "simple" | "complex"; xml: string; instruction: string; cachedText?: string }> = []
    for (const match of xml.matchAll(/<w:fldSimple\b[^>]*\/>|<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/g)) {
      const instruction = xmlAttrValue(match[0], "instr")
      if (!instruction) continue
      const cachedText = xmlTextFrom(match[0]).trim()
      candidates.push({
        offset: match.index ?? 0,
        fieldKind: "simple",
        xml: match[0],
        instruction: normalizeFieldInstruction(instruction),
        cachedText: cachedText || undefined,
      })
    }
    for (const match of xml.matchAll(/<w:r\b[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>[\s\S]*?<\/w:r>[\s\S]*?<w:r\b[\s\S]*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>[\s\S]*?<\/w:r>/g)) {
      const instruction = normalizeFieldInstruction(fieldInstrTextFrom(match[0]))
      if (!instruction) continue
      candidates.push({
        offset: match.index ?? 0,
        fieldKind: "complex",
        xml: match[0],
        instruction,
        cachedText: complexFieldCachedText(match[0]),
      })
    }
    candidates.sort((left, right) => left.offset - right.offset)
    for (const candidate of candidates) {
      fieldIndex += 1
      const blockId = `field-${fieldIndex}`
      const type = fieldType(candidate.instruction)
      const location = makeSourceLocation(inputPath, fieldIndex, [part], blockId)
      const normalized = normalizedHash([part, candidate.fieldKind, type, candidate.instruction, candidate.cachedText].filter(Boolean).join("\n"))
      const locator: WordDocumentLocator = {
        kind: "field",
        blockId,
        fieldIndex,
        fieldType: type,
        sourceLocation: location,
        normalizedHash: normalized,
      }
      fields.push({
        id: blockId,
        blockId,
        fieldIndex,
        part,
        fieldKind: candidate.fieldKind,
        type,
        instruction: candidate.instruction,
        cachedText: candidate.cachedText,
        sourceLocation: location,
        normalizedHash: normalized,
        locator,
      })
    }
  }
  return fields
}

function fieldPartNames(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((name) => name === "word/document.xml" || /^word\/(?:header|footer)\d+\.xml$/.test(name) || name === "word/footnotes.xml" || name === "word/endnotes.xml")
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b))
}

function fieldTypeCountsFrom(fields: WordDocumentFieldInspection[]) {
  const counts = new Map<string, number>()
  for (const field of fields) counts.set(field.type, (counts.get(field.type) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])))
}

function fieldInstrTextFrom(xml: string) {
  return (xml.match(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g) ?? [])
    .map((tag) => decodeXml(tag.replace(/^<w:instrText\b[^>]*>/, "").replace(/<\/w:instrText>$/, "")))
    .join("")
}

function complexFieldCachedText(xml: string) {
  const runs = xml.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []
  const separateIndex = runs.findIndex((run) => /<w:fldChar\b[^>]*w:fldCharType="separate"[^>]*\/>/.test(run))
  if (separateIndex < 0) return undefined
  const endIndex = runs.findIndex((run, index) => index > separateIndex && /<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/.test(run))
  if (endIndex < 0 || endIndex <= separateIndex + 1) return undefined
  const cachedText = xmlTextFrom(runs.slice(separateIndex + 1, endIndex).join("")).trim()
  return cachedText || undefined
}

function fieldType(instruction: string) {
  return normalizeFieldInstruction(instruction).split(/\s+/)[0]?.toUpperCase() || "(empty)"
}

function normalizeFieldInstruction(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function extractSections(documentXml: string, inputPath: string, settingsXml = ""): WordDocumentSectionInspection[] {
  const sections: WordDocumentSectionInspection[] = []
  const matches = Array.from(documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g))
  const oddEvenHeaders = /<w:evenAndOddHeaders\b/.test(settingsXml)
  for (const [index, match] of matches.entries()) {
    const sectionIndex = index + 1
    const sectionXml = match[0]
    const blockId = `section-${sectionIndex}`
    const location = makeSourceLocation(inputPath, sectionIndex, [], blockId)
    const pageSize = sectionXml.match(/<w:pgSz\b[^>]*\/?>/)?.[0]
    const pageMargins = sectionXml.match(/<w:pgMar\b[^>]*\/?>/)?.[0]
    const widthTwips = pageSize ? numberAttrValue(pageSize, "w") : undefined
    const heightTwips = pageSize ? numberAttrValue(pageSize, "h") : undefined
    const orient = pageSize ? xmlAttrValue(pageSize, "orient") : undefined
    const orientation = sectionOrientation(orient, widthTwips, heightTwips)
    const headers = (sectionXml.match(/<w:headerReference\b[^>]*\/?>/g) ?? []).map((item) => ({
      type: xmlAttrValue(item, "type"),
      relId: xmlAttrValue(item, "id"),
    }))
    const footers = (sectionXml.match(/<w:footerReference\b[^>]*\/?>/g) ?? []).map((item) => ({
      type: xmlAttrValue(item, "type"),
      relId: xmlAttrValue(item, "id"),
    }))
    const differentFirstPage = /<w:titlePg\b/.test(sectionXml)
    const sectionType = sectionXml.match(/<w:type\b[^>]*\/?>/)?.[0]
    const normalized = normalizedHash([sectionXml, sectionIndex].join("\n"))
    const locator: WordDocumentLocator = {
      kind: "section",
      blockId,
      sectionIndex,
      sourceLocation: location,
      normalizedHash: normalized,
    }
    sections.push({
      id: blockId,
      blockId,
      sectionIndex,
      part: "word/document.xml",
      type: sectionType ? xmlAttrValue(sectionType, "val") : undefined,
      isFinal: index === matches.length - 1,
      differentFirstPage,
      oddEvenHeaders,
      page: {
        widthTwips,
        heightTwips,
        orientation,
        margins: pageMargins ? {
          top: numberAttrValue(pageMargins, "top"),
          right: numberAttrValue(pageMargins, "right"),
          bottom: numberAttrValue(pageMargins, "bottom"),
          left: numberAttrValue(pageMargins, "left"),
          header: numberAttrValue(pageMargins, "header"),
          footer: numberAttrValue(pageMargins, "footer"),
          gutter: numberAttrValue(pageMargins, "gutter"),
        } : undefined,
      },
      headers,
      footers,
      headerFooterLinks: sectionHeaderFooterLinks({
        sectionIndex,
        differentFirstPage,
        oddEvenHeaders,
        headers,
        footers,
      }),
      sourceLocation: location,
      normalizedHash: normalized,
      locator,
    })
  }
  return sections
}

function sectionHeaderFooterLinks(input: {
  sectionIndex: number
  differentFirstPage: boolean
  oddEvenHeaders: boolean
  headers: SectionHeaderFooterReference[]
  footers: SectionHeaderFooterReference[]
}): WordDocumentSectionInspection["headerFooterLinks"] {
  const types: Array<"default" | "first" | "even"> = ["default"]
  if (input.differentFirstPage) types.push("first")
  if (input.oddEvenHeaders) types.push("even")
  return [
    ...types.map((type) => headerFooterLink("header", type, input.headers, input.sectionIndex)),
    ...types.map((type) => headerFooterLink("footer", type, input.footers, input.sectionIndex)),
  ]
}

function headerFooterLink(
  kind: "header" | "footer",
  type: "default" | "first" | "even",
  references: SectionHeaderFooterReference[],
  sectionIndex: number,
): WordDocumentSectionInspection["headerFooterLinks"][number] {
  const reference = references.find((item) => (item.type || "default") === type)
  return {
    kind,
    type,
    relId: reference?.relId,
    hasReference: Boolean(reference?.relId),
    linkedToPrevious: sectionIndex > 1 && !reference?.relId,
  }
}

function sectionOrientation(orient: string | undefined, widthTwips: number | undefined, heightTwips: number | undefined): "portrait" | "landscape" | undefined {
  if (orient === "landscape") return "landscape"
  if (orient === "portrait") return "portrait"
  if (widthTwips === undefined || heightTwips === undefined) return undefined
  return widthTwips > heightTwips ? "landscape" : "portrait"
}

async function extractImages(zip: ZipArchive, inputPath: string): Promise<WordDocumentImageInspection[]> {
  const images: WordDocumentImageInspection[] = []
  let index = 0
  const contentTypes = await contentTypesByPart(zip)
  for (const part of imagePartNames(zip)) {
    const xml = await zip.file(part)?.async("string").catch(() => "")
    if (!xml) continue
    const relationships = await relationshipsById(zip, part)
    for (const match of xml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
      index += 1
      const drawingXml = match[0]
      const relId = xmlAttrValue(drawingXml, "embed") ?? xmlAttrValue(drawingXml, "link")
      const relationship = relId ? relationships.get(relId) : undefined
      const placement = imagePlacement(drawingXml)
      const relationshipMode = imageRelationshipMode(drawingXml, relId, relationship)
      const docPr = drawingXml.match(/<wp:docPr\b[^>]*\/?>/)?.[0]
      const picNvPr = drawingXml.match(/<pic:cNvPr\b[^>]*\/?>/)?.[0]
      const extent = drawingXml.match(/<wp:extent\b[^>]*\/?>/)?.[0] ?? drawingXml.match(/<a:ext\b[^>]*\/?>/)?.[0]
      const target = relationship?.target
      const mediaPath = relationshipMode === "embedded" ? resolveRelationshipTarget(part, relationship?.target) : undefined
      const mediaExtension = imageMediaExtension(mediaPath ?? target)
      const contentType = mediaPath ? contentTypeForPackagePart(contentTypes, mediaPath) : undefined
      const mediaExists = mediaPath ? Boolean(zip.file(mediaPath)) : undefined
      const replaceUnsupportedReason = imageReplaceUnsupportedReason({ relationshipMode, mediaPath, mediaExtension })
      const replaceSupported = !replaceUnsupportedReason
      const blockId = `image-${index}`
      const location = makeSourceLocation(inputPath, index, [part], blockId)
      const name = (docPr && xmlAttrValue(docPr, "name")) || (picNvPr && xmlAttrValue(picNvPr, "name"))
      const altText = (docPr && (xmlAttrValue(docPr, "descr") ?? xmlAttrValue(docPr, "title"))) || undefined
      const widthEmu = extent ? numberAttrValue(extent, "cx") : undefined
      const heightEmu = extent ? numberAttrValue(extent, "cy") : undefined
      const locator: WordDocumentLocator = {
        kind: "image",
        blockId,
        imageIndex: index,
        imageRelId: relId,
        imageTarget: target,
        sourceLocation: location,
        normalizedHash: normalizedHash([part, placement, relationshipMode, relId, target, relationship?.targetMode, mediaPath, mediaExtension, contentType, mediaExists, replaceSupported, replaceUnsupportedReason, name, altText, widthEmu, heightEmu].filter((item) => item !== undefined && item !== "").join("\n")),
      }
      images.push({
        id: blockId,
        blockId,
        imageIndex: index,
        part,
        placement,
        relId,
        target,
        targetMode: relationship?.targetMode,
        relationshipMode,
        mediaPath,
        mediaExtension,
        contentType,
        mediaExists,
        name,
        altText,
        widthEmu,
        heightEmu,
        replaceSupported,
        replaceUnsupportedReason,
        sourceLocation: location,
        normalizedHash: locator.normalizedHash!,
        locator,
      })
    }
  }
  return images
}

type ContentTypesByPart = {
  defaults: Map<string, string>
  overrides: Map<string, string>
}

async function contentTypesByPart(zip: ZipArchive): Promise<ContentTypesByPart> {
  const xml = await zip.file("[Content_Types].xml")?.async("string").catch(() => "")
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  if (!xml) return { defaults, overrides }
  for (const match of xml.matchAll(/<Default\b[^>]*\/?>/g)) {
    const extension = xmlAttrValue(match[0], "Extension")?.toLowerCase()
    const contentType = xmlAttrValue(match[0], "ContentType")
    if (extension && contentType) defaults.set(extension, contentType)
  }
  for (const match of xml.matchAll(/<Override\b[^>]*\/?>/g)) {
    const partName = xmlAttrValue(match[0], "PartName")?.replace(/^\/+/, "")
    const contentType = xmlAttrValue(match[0], "ContentType")
    if (partName && contentType) overrides.set(partName, contentType)
  }
  return { defaults, overrides }
}

function contentTypeForPackagePart(contentTypes: ContentTypesByPart, partPath: string) {
  const normalized = partPath.replace(/^\/+/, "")
  return contentTypes.overrides.get(normalized) ?? contentTypes.defaults.get(imageMediaExtension(normalized) ?? "")
}

function imagePlacement(drawingXml: string): WordDocumentImageInspection["placement"] {
  if (/<wp:anchor\b/.test(drawingXml)) return "floating"
  if (/<wp:inline\b/.test(drawingXml)) return "inline"
  return "unknown"
}

function imageRelationshipMode(drawingXml: string, relId: string | undefined, relationship: WordRelationship | undefined): WordDocumentImageInspection["relationshipMode"] {
  if (!relId || !relationship) return "missing"
  if (relationship.targetMode === "External" || /\br:link="/.test(drawingXml)) return "external"
  return "embedded"
}

function imageMediaExtension(pathOrTarget: string | undefined) {
  const filename = pathOrTarget?.split(/[?#]/, 1)[0]?.split("/").pop()
  const extension = filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]
  return extension?.toLowerCase()
}

function imageReplaceUnsupportedReason(input: { relationshipMode: WordDocumentImageInspection["relationshipMode"]; mediaPath?: string; mediaExtension?: string }) {
  if (input.relationshipMode === "missing") return "missing-image-relationship"
  if (input.relationshipMode === "external") return "external-linked-image"
  if (!input.mediaPath) return "unresolved-media-target"
  if (input.mediaExtension !== "png") return "non-png-media"
  return undefined
}

async function extractHyperlinks(zip: ZipArchive, inputPath: string): Promise<WordDocumentHyperlinkInspection[]> {
  const part = "word/document.xml"
  const documentXml = await zip.file(part)?.async("string")
  if (!documentXml) return []
  const relationships = await relationshipsById(zip, part)
  const hyperlinks: WordDocumentHyperlinkInspection[] = []
  let index = 0
  for (const match of documentXml.matchAll(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>/g)) {
    const xml = match[0]
    const relId = xmlAttrValue(xml, "id")
    const anchor = xmlAttrValue(xml, "anchor")
    const text = xmlTextFrom(xml).trim().slice(0, 1000)
    if (!relId && !anchor && !text) continue
    index += 1
    const relationship = relId ? relationships.get(relId) : undefined
    const blockId = `hyperlink-${index}`
    const target = relationship?.target
    const location = makeSourceLocation(inputPath, index, [], blockId)
    const locator: WordDocumentLocator = {
      kind: "hyperlink",
      blockId,
      hyperlinkIndex: index,
      hyperlinkRelId: relId,
      hyperlinkAnchor: anchor,
      sourceLocation: location,
      normalizedHash: normalizedHash([index, relId ?? "", target ?? "", anchor ?? "", text].join("\n")),
    }
    hyperlinks.push({
      id: blockId,
      blockId,
      hyperlinkIndex: index,
      part,
      text,
      relId,
      target,
      anchor,
      tooltip: xmlAttrValue(xml, "tooltip"),
      sourceLocation: location,
      normalizedHash: locator.normalizedHash!,
      locator,
    })
  }
  return hyperlinks
}

function imagePartNames(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((name) => name === "word/document.xml" || /^word\/(?:header|footer)\d+\.xml$/.test(name) || name === "word/footnotes.xml" || name === "word/endnotes.xml")
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b))
}

type WordRelationship = {
  id: string
  target?: string
  targetMode?: string
}

async function relationshipsById(zip: ZipArchive, sourcePart: string): Promise<Map<string, WordRelationship>> {
  const relsXml = await zip.file(relationshipPartName(sourcePart))?.async("string").catch(() => "")
  const relationships = new Map<string, WordRelationship>()
  if (!relsXml) return relationships
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const xml = match[0]
    const id = xmlAttrValue(xml, "Id")
    if (!id) continue
    relationships.set(id, {
      id,
      target: xmlAttrValue(xml, "Target"),
      targetMode: xmlAttrValue(xml, "TargetMode"),
    })
  }
  return relationships
}

function relationshipPartName(sourcePart: string) {
  const slash = sourcePart.lastIndexOf("/")
  if (slash < 0) return `_rels/${sourcePart}.rels`
  const dir = sourcePart.slice(0, slash + 1)
  const filename = sourcePart.slice(slash + 1)
  return `${dir}_rels/${filename}.rels`
}

function resolveRelationshipTarget(sourcePart: string, target: string | undefined) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined
  const raw = target.startsWith("/") ? target.slice(1) : `${sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1)}${target}`
  return normalizePackagePath(raw)
}

function normalizePackagePath(path: string) {
  const parts: string[] = []
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") parts.pop()
    else parts.push(segment)
  }
  return parts.join("/")
}

async function extractNotes(zip: ZipArchive, inputPath: string): Promise<WordDocumentNoteInspection[]> {
  const notes: WordDocumentNoteInspection[] = []
  for (const item of [
    { kind: "footnote" as const, part: "word/footnotes.xml", tag: "footnote" },
    { kind: "endnote" as const, part: "word/endnotes.xml", tag: "endnote" },
  ]) {
    const xml = await zip.file(item.part)?.async("string").catch(() => "")
    if (!xml) continue
    const pattern = new RegExp(`<w:${item.tag}\\b[\\s\\S]*?<\\/w:${item.tag}>`, "g")
    for (const match of xml.matchAll(pattern)) {
      const noteXml = match[0]
      const noteId = xmlAttrValue(noteXml, "id")
      const noteType = xmlAttrValue(noteXml, "type")
      if (!noteId || noteId === "-1" || noteId === "0" || noteType === "separator" || noteType === "continuationSeparator") continue
      const text = noteTextFromXml(noteXml).trim().slice(0, 4000)
      if (!text) continue
      const noteIndex = notes.length + 1
      const blockId = `${item.kind}-${noteId}`
      const location = makeSourceLocation(inputPath, noteIndex, [item.part], blockId)
      const locator: WordDocumentLocator = {
        kind: "note",
        blockId,
        noteIndex,
        noteKind: item.kind,
        noteId,
        sourceLocation: location,
        normalizedHash: normalizedHash(`${item.part}\n${noteId}\n${text}`),
      }
      notes.push({
        id: blockId,
        blockId,
        noteIndex,
        noteKind: item.kind,
        noteId,
        part: item.part,
        text,
        sourceLocation: location,
        normalizedHash: locator.normalizedHash!,
        locator,
      })
    }
  }
  return notes
}

function noteTextFromXml(noteXml: string) {
  const paragraphs = noteXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []
  const paragraphTexts = paragraphs.map((paragraph) => xmlTextFrom(paragraph).trim()).filter(Boolean)
  if (paragraphTexts.length) return paragraphTexts.join("\n")
  return xmlTextFrom(noteXml)
}

async function extractWatermarks(zip: ZipArchive, inputPath: string): Promise<WordDocumentWatermarkInspection[]> {
  const watermarks: WordDocumentWatermarkInspection[] = []
  let index = 0
  const contentTypes = await contentTypesByPart(zip)
  for (const part of watermarkPartNames(zip)) {
    const xml = await zip.file(part)?.async("string").catch(() => "")
    if (!xml) continue
    const relationships = await relationshipsById(zip, part)
    for (const candidate of watermarkCandidatesFromPart(xml, part, relationships, contentTypes, zip)) {
      index += 1
      const blockId = `watermark-${index}`
      const location = makeSourceLocation(inputPath, index, [part], blockId)
      const locator: WordDocumentLocator = {
        kind: "watermark",
        blockId,
        watermarkIndex: index,
        watermarkText: candidate.text,
        imageRelId: candidate.relId,
        imageTarget: candidate.target,
        sourceLocation: location,
        normalizedHash: normalizedHash([
          part,
          candidate.kind,
          candidate.text,
          candidate.relId,
          candidate.target,
          candidate.targetMode,
          candidate.relationshipMode,
          candidate.mediaPath,
          candidate.mediaExtension,
          candidate.contentType,
          candidate.mediaExists,
        ].filter((item) => item !== undefined && item !== "").join("\n")),
      }
      watermarks.push({
        id: blockId,
        blockId,
        watermarkIndex: index,
        part,
        kind: candidate.kind,
        text: candidate.text,
        relId: candidate.relId,
        target: candidate.target,
        targetMode: candidate.targetMode,
        relationshipMode: candidate.relationshipMode,
        mediaPath: candidate.mediaPath,
        mediaExtension: candidate.mediaExtension,
        contentType: candidate.contentType,
        mediaExists: candidate.mediaExists,
        sourceLocation: location,
        normalizedHash: locator.normalizedHash!,
        locator,
      })
    }
  }
  return watermarks
}

function watermarkPartNames(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((name) => name === "word/document.xml" || /^word\/(?:header|footer)\d+\.xml$/.test(name))
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b))
}

function watermarkCandidatesFromPart(
  xml: string,
  part: string,
  relationships: Map<string, WordRelationship>,
  contentTypes: ContentTypesByPart,
  zip: ZipArchive,
) {
  const candidates: WatermarkCandidate[] = []
  for (const match of xml.matchAll(/<w:pict\b[\s\S]*?<\/w:pict>/g)) {
    const pict = match[0]
    const text = watermarkTextFromPict(pict)
    if (text) {
      candidates.push({ offset: match.index ?? 0, kind: "vmlTextPath", text })
      continue
    }
    const image = vmlImageWatermarkCandidate(pict, part, relationships, contentTypes, zip)
    if (image) candidates.push({ ...image, offset: match.index ?? 0 })
  }
  for (const match of xml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
    const drawing = drawingImageBackgroundCandidate(match[0], part, relationships, contentTypes, zip)
    if (drawing) candidates.push({ ...drawing, offset: match.index ?? 0 })
  }
  return candidates.sort((left, right) => left.offset - right.offset)
}

function vmlImageWatermarkCandidate(
  pictXml: string,
  part: string,
  relationships: Map<string, WordRelationship>,
  contentTypes: ContentTypesByPart,
  zip: ZipArchive,
): Omit<WatermarkCandidate, "offset"> | undefined {
  if (!/<(?:[A-Za-z0-9]+:)?imagedata\b/i.test(pictXml)) return undefined
  if (!/^word\/(?:header|footer)\d+\.xml$/.test(part) && !/z-index\s*:\s*-/i.test(pictXml)) return undefined
  const imageData = pictXml.match(/<(?:[A-Za-z0-9]+:)?imagedata\b[^>]*\/?>/i)?.[0] ?? pictXml
  const relId = xmlAttrValue(imageData, "id") ?? xmlAttrValue(imageData, "relid")
  const relationship = relId ? relationships.get(relId) : undefined
  return imageBackgroundCandidate({
    part,
    kind: "vmlImageShape",
    relId,
    relationship,
    contentTypes,
    zip,
    fallbackText: "VML image background",
  })
}

function drawingImageBackgroundCandidate(
  drawingXml: string,
  part: string,
  relationships: Map<string, WordRelationship>,
  contentTypes: ContentTypesByPart,
  zip: ZipArchive,
): Omit<WatermarkCandidate, "offset"> | undefined {
  if (!/<wp:anchor\b/.test(drawingXml)) return undefined
  const isHeaderFooter = /^word\/(?:header|footer)\d+\.xml$/.test(part)
  const isBehindText = /\bbehindDoc="1"/.test(drawingXml) || /\bbehindDoc="true"/.test(drawingXml)
  if (!isHeaderFooter && !isBehindText) return undefined
  const relId = xmlAttrValue(drawingXml, "embed") ?? xmlAttrValue(drawingXml, "link")
  const relationship = relId ? relationships.get(relId) : undefined
  return imageBackgroundCandidate({
    part,
    kind: "drawingImageBackground",
    relId,
    relationship,
    contentTypes,
    zip,
    fallbackText: "DrawingML image background",
  })
}

function imageBackgroundCandidate(input: {
  part: string
  kind: "vmlImageShape" | "drawingImageBackground"
  relId?: string
  relationship?: WordRelationship
  contentTypes: ContentTypesByPart
  zip: ZipArchive
  fallbackText: string
}): Omit<WatermarkCandidate, "offset"> {
  const relationshipMode = !input.relId || !input.relationship
    ? "missing"
    : input.relationship.targetMode === "External"
      ? "external"
      : "embedded"
  const target = input.relationship?.target
  const mediaPath = relationshipMode === "embedded" ? resolveRelationshipTarget(input.part, target) : undefined
  const mediaExtension = imageMediaExtension(mediaPath ?? target)
  const contentType = mediaPath ? contentTypeForPackagePart(input.contentTypes, mediaPath) : undefined
  const mediaExists = mediaPath ? Boolean(input.zip.file(mediaPath)) : undefined
  const text = [
    input.fallbackText,
    mediaPath || target || input.relId || "missing relationship",
  ].join(": ")
  return {
    kind: input.kind,
    text,
    relId: input.relId,
    target,
    targetMode: input.relationship?.targetMode,
    relationshipMode,
    mediaPath,
    mediaExtension,
    contentType,
    mediaExists,
  }
}

function watermarkTextFromPict(pictXml: string) {
  const match = pictXml.match(/<(?:[A-Za-z0-9]+:)?textpath\b[^>]*\bstring="([^"]*)"/i)
  return match?.[1] ? decodeXml(match[1]).trim() : ""
}

function extractContentControls(documentXml: string, inputPath: string): WordDocumentContentControlInspection[] {
  const controls: WordDocumentContentControlInspection[] = []
  for (const block of topLevelSdtXmlBlocks(documentXml)) {
    const index = block.index
    const xml = block.xml
    const blockId = `sdt-${index}`
    const tag = xml.match(/<w:tag\b[^>]*\bw:val="([^"]*)"/)?.[1]
    const title = xml.match(/<w:alias\b[^>]*\bw:val="([^"]*)"/)?.[1]
    const text = xmlTextFrom(xml).trim()
    const kind = contentControlKindFromXml(xml)
    const fillAnalysis = analyzeContentControlFillSupport(xml, kind, block.nestedControlCount)
    const options = kind === "dropdown" ? dropdownOptions(xml) : undefined
    const checked = kind === "checkbox" ? checkboxChecked(xml, text) : undefined
    const dateFormat = kind === "date" ? xmlAttrValue(xml.match(/<w:dateFormat\b[^>]*\/?>/)?.[0] ?? "", "val") : undefined
    const location = makeSourceLocation(inputPath, index, [], blockId)
    const locator: WordDocumentLocator = {
      kind: "contentControl",
      blockId,
      contentControlIndex: index,
      contentControlTag: tag ? decodeXml(tag) : undefined,
      contentControlTitle: title ? decodeXml(title) : undefined,
      sourceLocation: location,
      normalizedHash: normalizedHash([tag, title, kind, text, checked, options?.join("|"), dateFormat].filter((item) => item !== undefined && item !== "").join("\n")),
    }
    controls.push({
      id: blockId,
      blockId,
      contentControlIndex: index,
      tag: locator.contentControlTag,
      title: locator.contentControlTitle,
      text,
      kind,
      fillSupported: fillAnalysis.fillSupported,
      fillUnsupportedReason: fillAnalysis.fillUnsupportedReason,
      nestedControlCount: block.nestedControlCount,
      hasRichContent: fillAnalysis.hasRichContent,
      checked,
      options,
      dateFormat,
      sourceLocation: location,
      normalizedHash: locator.normalizedHash!,
      locator,
    })
  }
  return controls
}

async function extractDocumentProtection(zip: ZipArchive, inputPath: string): Promise<WordDocumentProtectionInspection | undefined> {
  const settingsXml = await zip.file("word/settings.xml")?.async("string")
  if (!settingsXml) return undefined
  const tag = settingsXml.match(/<w:documentProtection\b[^>]*\/?>/)?.[0]
  if (!tag) return undefined
  const mode = protectionModeFromEdit(xmlAttrValue(tag, "edit"))
  if (!mode) return undefined
  const blockId = "document-protection"
  const enforced = xmlBoolean(xmlAttrValue(tag, "enforcement"), true) ?? true
  const formatting = xmlBoolean(xmlAttrValue(tag, "formatting"), undefined)
  const location = makeSourceLocation(inputPath, 1, [], blockId)
  const locator: WordDocumentLocator = {
    kind: "documentProtection",
    blockId,
    protectionMode: mode,
    sourceLocation: location,
    normalizedHash: normalizedHash([mode, enforced, formatting].filter((item) => item !== undefined).join("\n")),
  }
  return {
    id: blockId,
    blockId,
    part: "word/settings.xml",
    mode,
    enforced,
    formatting,
    sourceLocation: location,
    normalizedHash: locator.normalizedHash!,
    locator,
  }
}

function protectionModeFromEdit(input: string | undefined): WordDocumentProtectionInspection["mode"] | undefined {
  if (input === "readOnly" || input === "comments" || input === "trackedChanges" || input === "forms") return input
  return undefined
}

function xmlBoolean(input: string | undefined, fallback: boolean | undefined) {
  if (input === undefined) return fallback
  if (input === "1" || input.toLowerCase() === "true" || input.toLowerCase() === "on") return true
  if (input === "0" || input.toLowerCase() === "false" || input.toLowerCase() === "off") return false
  return fallback
}

function dropdownOptions(xml: string) {
  const options: string[] = []
  for (const item of xml.match(/<w:listItem\b[^>]*\/?>/g) ?? []) {
    const value = xmlAttrValue(item, "displayText") ?? xmlAttrValue(item, "value")
    if (value && !options.includes(value)) options.push(value)
  }
  return options.length ? options : undefined
}

function checkboxChecked(xml: string, text: string) {
  const checkedTag = xml.match(/<w14:checked\b[^>]*\/?>/)?.[0]
  const raw = checkedTag ? xmlAttrValue(checkedTag, "val") : undefined
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  if (/☑|true|checked|yes|是|已选|勾选/i.test(text)) return true
  if (/☐|false|unchecked|no|否|未选/i.test(text)) return false
  return undefined
}

async function extractComments(zip: ZipArchive, inputPath: string): Promise<WordDocumentCommentInspection[]> {
  const commentsXml = await zip.file("word/comments.xml")?.async("string")
  if (!commentsXml) return []
  const anchorsById = await commentAnchorsById(zip)
  const extendedByParaId = await commentsExtendedByParaId(zip)
  const idsByParaId = await commentsIdsByParaId(zip)
  const comments: WordDocumentCommentInspection[] = []
  let index = 0
  for (const match of commentsXml.matchAll(/<w:comment\b[\s\S]*?<\/w:comment>/g)) {
    const xml = match[0]
    const commentId = xmlAttrValue(xml, "id")
    if (!commentId) continue
    index += 1
    const firstParagraph = xml.match(/<w:p\b[^>]*>/)?.[0]
    const paraId = firstParagraph ? xmlAttrValue(firstParagraph, "paraId") : undefined
    const extended = paraId ? extendedByParaId.get(paraId) : undefined
    const ids = paraId ? idsByParaId.get(paraId) : undefined
    const paragraphTexts = (xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [])
      .map((paragraph) => xmlTextFrom(paragraph).trim())
      .filter(Boolean)
    const text = (paragraphTexts.length ? paragraphTexts.join("\n") : xmlTextFrom(xml).trim()).slice(0, 4000)
    const anchors = anchorsById.get(commentId) ?? []
    const commentDone = xmlBoolean(xmlAttrValue(xml, "done"), false) === true
    const extendedDone = extended?.done
    const resolved = commentDone || extendedDone === true
    const resolvedSource = commentDone && extendedDone === true ? "both" : commentDone ? "comment" : extendedDone === true ? "commentsExtended" : "none"
    const locator: WordDocumentLocator = {
      kind: "comment",
      blockId: `comment-${commentId}`,
      commentId,
      sourceLocation: { path: inputPath, sourceBlockId: `comment-${commentId}`, blockIndex: index },
      normalizedHash: normalizedHash(`${commentId}\n${text}\n${paraId ?? ""}\n${extended?.parentParaId ?? ""}\n${ids?.durableId ?? ""}\n${resolvedSource}`),
    }
    comments.push({
      id: `comment-${commentId}`,
      commentId,
      text,
      author: xmlAttrValue(xml, "author"),
      initials: xmlAttrValue(xml, "initials"),
      date: xmlAttrValue(xml, "date"),
      resolved,
      resolvedSource,
      paraId,
      parentParaId: extended?.parentParaId,
      durableId: ids?.durableId,
      commentsExtendedDone: extendedDone,
      anchorText: anchors.find((anchor) => anchor.text)?.text,
      anchors,
      locator,
    })
  }
  const commentIdByParaId = new Map(comments.flatMap((comment) => comment.paraId ? [[comment.paraId, comment.commentId] as const] : []))
  for (const comment of comments) {
    if (comment.parentParaId) comment.parentCommentId = commentIdByParaId.get(comment.parentParaId)
  }
  return comments
}

type CommentExtendedMetadata = {
  paraId: string
  parentParaId?: string
  done?: boolean
}

type CommentIdsMetadata = {
  paraId: string
  durableId?: string
}

async function commentsExtendedByParaId(zip: ZipArchive): Promise<Map<string, CommentExtendedMetadata>> {
  const xml = await zip.file("word/commentsExtended.xml")?.async("string").catch(() => "")
  const result = new Map<string, CommentExtendedMetadata>()
  if (!xml) return result
  for (const match of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?commentEx\b[^>]*\/?>/g)) {
    const tag = match[0]
    const paraId = xmlAttrValue(tag, "paraId")
    if (!paraId) continue
    result.set(paraId, {
      paraId,
      parentParaId: xmlAttrValue(tag, "paraIdParent") ?? xmlAttrValue(tag, "parentParaId"),
      done: xmlBoolean(xmlAttrValue(tag, "done"), undefined),
    })
  }
  return result
}

async function commentsIdsByParaId(zip: ZipArchive): Promise<Map<string, CommentIdsMetadata>> {
  const xml = await zip.file("word/commentsIds.xml")?.async("string").catch(() => "")
  const result = new Map<string, CommentIdsMetadata>()
  if (!xml) return result
  for (const match of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?commentId\b[^>]*\/?>/g)) {
    const tag = match[0]
    const paraId = xmlAttrValue(tag, "paraId")
    if (!paraId) continue
    result.set(paraId, {
      paraId,
      durableId: xmlAttrValue(tag, "durableId"),
    })
  }
  return result
}

async function commentAnchorsById(zip: ZipArchive) {
  const anchors = new Map<string, Array<{ part: string; text?: string }>>()
  for (const part of storyPartNames(zip)) {
    const xml = await zip.file(part)?.async("string").catch(() => "")
    if (!xml) continue
    for (const paragraph of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
      const ids = new Set<string>()
      for (const tag of paragraph.match(/<w:commentRange(?:Start|End)\b[^>]*>/g) ?? []) {
        const id = xmlAttrValue(tag, "id")
        if (id) ids.add(id)
      }
      for (const id of ids) {
        const text = xmlTextFrom(paragraph).trim().slice(0, 240)
        const list = anchors.get(id) ?? []
        list.push({ part, text: text || undefined })
        anchors.set(id, list)
      }
    }
    for (const match of xml.matchAll(/<w:commentRangeStart\b[^>]*\bw:id="([^"]+)"[^>]*\/>\s*(<w:p\b[\s\S]*?<\/w:p>)/g)) {
      const id = decodeXml(match[1] ?? "")
      if (!id) continue
      const text = xmlTextFrom(match[2] ?? "").trim().slice(0, 240)
      const list = anchors.get(id) ?? []
      if (!list.some((item) => item.part === part && item.text === text)) list.push({ part, text: text || undefined })
      anchors.set(id, list)
    }
  }
  return anchors
}

function storyPartNames(zip: ZipArchive) {
  return Object.keys(zip.files)
    .filter((name) => name === "word/document.xml" || /^word\/(?:header|footer)\d+\.xml$/.test(name))
    .sort((a, b) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b))
}

function trackedChangeTypeCounts(documentXml: string) {
  const trackedTypes = ["ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange"] as const
  const counts: Record<string, number> = {}
  for (const type of trackedTypes) {
    const count = (documentXml.match(new RegExp(`<w:${type}\\b`, "g")) ?? []).length
    if (count > 0) counts[type] = count
  }
  return counts
}

function trackedChangeCount(counts: Record<string, number>) {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

function advancedTrackedChangeWarnings(counts: Record<string, number>) {
  const warnings: string[] = []
  const moveCount = (counts.moveFrom ?? 0) + (counts.moveTo ?? 0)
  if (moveCount > 0) {
    warnings.push(`Tracked move revisions detected (${moveCount}); accept/reject can unwrap moveTo or moveFrom but cannot preserve move-pair metadata.`)
  }
  const formattingTypes = ["rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange"]
  const formattingSummary = formattingTypes
    .map((type) => [type, counts[type] ?? 0] as const)
    .filter(([, count]) => count > 0)
  if (formattingSummary.length) {
    warnings.push(`Tracked formatting revisions detected (${formattingSummary.map(([type, count]) => `${type}:${count}`).join(", ")}); accept/reject is fail-closed for these revisions.`)
  }
  return warnings
}

export async function loadDocxZip(bytes: Uint8Array): Promise<ZipArchive> {
  const JSZip = nodeRequire("jszip") as JsZipModule
  return await JSZip.loadAsync(Buffer.from(bytes)) as ZipArchive
}

export function parseTopLevelElements(documentXml: string): WordTopLevelElement[] {
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? ""
  const elements: WordTopLevelElement[] = []
  let paragraphIndex = 0
  let tableIndex = 0
  for (const match of body.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const xml = match[0]
    const blockIndex = elements.length + 1
    if (xml.startsWith("<w:tbl")) {
      tableIndex += 1
      elements.push({ kind: "table", xml, blockIndex, tableIndex, blockId: `tbl-${tableIndex}` })
    } else {
      paragraphIndex += 1
      elements.push({ kind: "paragraph", xml, blockIndex, paragraphIndex, blockId: `p-${paragraphIndex}` })
    }
  }
  return elements
}

export function normalizedHash(input: string) {
  return createHash("sha256").update(input.replace(/\s+/g, " ").trim(), "utf8").digest("hex")
}

export function xmlTextFrom(xml: string) {
  return (xml.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
    .map((tag) => decodeXml(tag.replace(/^<w:t\b[^>]*>/, "").replace(/<\/w:t>$/, "")))
    .join("")
    .replace(/\r\n/g, "\n")
}

export function paragraphStyleId(paragraphXml: string) {
  return paragraphXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1]
}

export function tableRows(tableXml: string) {
  return (tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).map((rowXml) =>
    (rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((cellXml) => xmlTextFrom(cellXml).trim()),
  )
}

function headingLevelFromStyle(styleId: string | undefined): 1 | 2 | 3 | undefined {
  if (!styleId) return undefined
  const normalized = styleId.replace(/\s+/g, "").toLowerCase()
  if (normalized === "heading1" || normalized === "1") return 1
  if (normalized === "heading2" || normalized === "2") return 2
  if (normalized === "heading3" || normalized === "3") return 3
  return undefined
}

function titleFrom(paragraphs: WordDocumentParagraphInspection[], path: string) {
  const heading = paragraphs.find((paragraph) => paragraph.headingLevel && paragraph.text.trim())
  if (heading) return heading.text.trim().slice(0, 120)
  const paragraph = paragraphs.find((item) => item.text.trim())
  if (paragraph) return paragraph.text.trim().slice(0, 120)
  return path.split(/[\\/]/).pop()?.replace(/\.docx$/i, "") || "Word document"
}

function makeSourceLocation(path: string, blockIndex: number, headingPath: string[], blockId: string): SourceLocation {
  return { path, headingPath, blockIndex, sourceBlockId: blockId }
}

function decodeXml(input: string) {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function xmlAttrValue(xml: string, name: string) {
  const match = xml.match(new RegExp(`\\b(?:[A-Za-z0-9_-]+:)?${escapeRegExp(name)}="([^"]*)"`))
  return match?.[1] ? decodeXml(match[1]) : undefined
}

function numberAttrValue(xml: string, name: string) {
  const value = xmlAttrValue(xml, name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
