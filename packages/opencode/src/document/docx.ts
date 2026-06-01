import path from "node:path"
import { XMLParser } from "fast-xml-parser"
import { configure, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type Entry } from "@zip.js/zip.js"

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

type XmlNode = Record<string, unknown>

type Relationship = {
  id: string
  type: string
  target: string
  mode?: string
}

type ImageRef = {
  target: string
  filename: string
  mime: string
  index: number
  size?: number
}

export type DocxImage = {
  filename: string
  mime: string
  data: string
  index: number
}

export type ExtractedDocx = {
  text: string
  images: DocxImage[]
  warnings: string[]
}

export type ExtractDocxOptions = {
  maxImages: number
  maxImageBytes: number
  maxTotalImageBytes: number
  timeoutMs: number
  maxTextChars: number
}

type ExtractContext = {
  entries: Map<string, Entry>
  images: ImageRef[]
  imageByTarget: Map<string, ImageRef>
  omittedByTarget: Map<string, string>
  warnings: string[]
  options: ExtractDocxOptions
  started: number
  totalImageBytes: number
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  preserveOrder: true,
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
})

const zipOptions = { useWebWorkers: false, useCompressionStream: false }
const imageMimes = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const defaultOptions: ExtractDocxOptions = {
  maxImages: 20,
  maxImageBytes: 3_932_160,
  maxTotalImageBytes: 20_971_520,
  timeoutMs: 30_000,
  maxTextChars: 200_000,
}

export function isDocxMime(mime: string) {
  return mime.split(";", 1)[0]?.trim().toLowerCase() === DOCX_MIME
}

export function formatDocxForModel(input: { filename?: string; docx: ExtractedDocx }) {
  const filename = escapeAttribute(input.filename ?? "document.docx")
  const body = input.docx.text.trim() || "(No text content extracted.)"
  const images =
    input.docx.images.length === 0
      ? ""
      : [
          "",
          "<images>",
          ...input.docx.images.map((image) => `${image.index}. ${image.filename} (${image.mime})`),
          "</images>",
        ].join("\n")
  const warnings =
    input.docx.warnings.length === 0
      ? ""
      : ["", "<warnings>", ...input.docx.warnings.map((warning) => `- ${warning}`), "</warnings>"].join("\n")

  return [`<docx filename="${filename}">`, body, images, warnings, "</docx>"].filter(Boolean).join("\n")
}

export async function extractDocx(bytes: Uint8Array, options?: Partial<ExtractDocxOptions>): Promise<ExtractedDocx> {
  configure(zipOptions)
  const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(bytes)), zipOptions)
  try {
    const entries = new Map((await reader.getEntries()).map((entry) => [entry.filename, entry]))
    const ctx: ExtractContext = {
      entries,
      images: [],
      imageByTarget: new Map(),
      omittedByTarget: new Map(),
      warnings: [],
      options: { ...defaultOptions, ...(options ?? {}) },
      started: Date.now(),
      totalImageBytes: 0,
    }
    const main = await extractPart(entries, "word/document.xml", "Document", ctx, false)
    const documentRelationships = await relationshipsFor(entries, "word/document.xml")
    const related = (
      await Promise.all(
        documentRelationships.ordered.flatMap((relationship) => {
          const kind = relationship.type.split("/").at(-1)
          if (relationship.mode === "External") return []
          if (kind !== "header" && kind !== "footer") return []
          return [extractPart(entries, relationship.target, kind === "header" ? "Header" : "Footer", ctx, true)]
        }),
      )
    ).filter(Boolean)
    const notes = (
      await Promise.all([
        extractPart(entries, "word/footnotes.xml", "Footnotes", ctx, true),
        extractPart(entries, "word/endnotes.xml", "Endnotes", ctx, true),
      ])
    ).filter(Boolean)
    const images: DocxImage[] = []
    for (const image of ctx.images) {
      const data = await readImage(ctx, image)
      if (data) images.push(data)
    }

    return {
      text: truncateText([main, ...related, ...notes].filter(Boolean).join("\n\n"), ctx),
      images,
      warnings: ctx.warnings,
    }
  } finally {
    await reader.close()
  }
}

async function extractPart(
  entries: Map<string, Entry>,
  file: string,
  label: string,
  ctx: ExtractContext,
  titled: boolean,
): Promise<string> {
  const xml = await readText(entries, file)
  if (!xml) return ""

  const relationships = await relationshipsFor(entries, file)
  const blocks = blocksForPart(parseXml(xml), relationships, ctx)
  if (!blocks) return ""
  if (!titled) return blocks
  return `## ${label}\n\n${blocks}`
}

function blocksForPart(
  nodes: XmlNode[],
  relationships: { byId: Map<string, Relationship> },
  ctx: ExtractContext,
): string {
  const root = firstByLocal(nodes, ["document", "hdr", "ftr", "footnotes", "endnotes"])
  const container = firstByLocal(children(root), ["body"]) ?? root
  const blocks = children(container)
    .flatMap((node) => {
      const name = localName(nodeName(node))
      if (name === "sectPr") return []
      if (name === "p") return [paragraphText(node, relationships, ctx)]
      if (name === "tbl") return [tableText(node, relationships, ctx)]
      if (name === "footnote" || name === "endnote") return [blockText(children(node), relationships, ctx)]
      return []
    })
    .map((text) => text.trim())
    .filter(Boolean)

  return blocks.join("\n\n")
}

function blockText(nodes: XmlNode[], relationships: { byId: Map<string, Relationship> }, ctx: ExtractContext): string {
  return nodes
    .flatMap((node) => {
      const name = localName(nodeName(node))
      if (name === "p") return [paragraphText(node, relationships, ctx)]
      if (name === "tbl") return [tableText(node, relationships, ctx)]
      return [inlineText([node], relationships, ctx)]
    })
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n")
}

function tableText(node: XmlNode, relationships: { byId: Map<string, Relationship> }, ctx: ExtractContext): string {
  return children(node)
    .filter((child) => localName(nodeName(child)) === "tr")
    .map((row) =>
      children(row)
        .filter((cell) => localName(nodeName(cell)) === "tc")
        .map((cell) =>
          blockText(children(cell), relationships, ctx)
            .replace(/\s*\n+\s*/g, " ")
            .trim(),
        )
        .join(" | "),
    )
    .filter(Boolean)
    .join("\n")
}

function paragraphText(node: XmlNode, relationships: { byId: Map<string, Relationship> }, ctx: ExtractContext): string {
  return inlineText(children(node), relationships, ctx).replace(/[ \t]+\n/g, "\n")
}

function inlineText(nodes: XmlNode[], relationships: { byId: Map<string, Relationship> }, ctx: ExtractContext): string {
  return nodes
    .map((node) => {
      const name = localName(nodeName(node))
      if (name === "#text") return textValue(node)
      if (name === "tab") return "\t"
      if (name === "br" || name === "cr") return "\n"

      const image = imageText(node, relationships, ctx)
      if (image) return image
      return inlineText(children(node), relationships, ctx)
    })
    .join("")
}

function imageText(node: XmlNode, relationships: { byId: Map<string, Relationship> }, ctx: ExtractContext) {
  const name = localName(nodeName(node))
  if (name !== "blip" && name !== "imagedata") return

  const attrs = attributes(node)
  const id = stringValue(attrs["r:embed"]) ?? stringValue(attrs["r:id"]) ?? stringValue(attrs.embed)
  if (!id) return

  const relationship = relationships.byId.get(id)
  if (!relationship) return `[Image omitted: missing relationship ${id}]`
  if (relationship.mode === "External") return
  if (!relationship.type.endsWith("/image")) return

  const mime = imageMime(relationship.target)
  const filename = path.posix.basename(relationship.target)
  const target = relationship.target
  const existing = ctx.imageByTarget.get(target)
  if (existing) return `[Image ${existing.index}: ${existing.filename}]`
  const omitted = ctx.omittedByTarget.get(target)
  if (omitted) return omitted

  if (timedOut(ctx))
    return omitImage(ctx, target, filename, `DOCX image extraction timed out after ${ctx.options.timeoutMs}ms.`)
  if (!mime) {
    return omitImage(ctx, target, filename, `Image ${filename} was omitted because its format is unsupported.`)
  }
  if (ctx.images.length >= ctx.options.maxImages) {
    return omitImage(
      ctx,
      target,
      filename,
      `Image ${filename} was omitted because the DOCX image count limit (${ctx.options.maxImages}) was reached.`,
    )
  }

  const entry = ctx.entries.get(target)
  if (!entry?.getData || entry.directory) {
    return omitImage(
      ctx,
      target,
      filename,
      `Image ${filename} was omitted because it was missing from the DOCX package.`,
    )
  }

  const size = entrySize(entry)
  if (size !== undefined && size > ctx.options.maxImageBytes) {
    return omitImage(
      ctx,
      target,
      filename,
      `Image ${filename} was omitted because it exceeded the per-image byte limit (${ctx.options.maxImageBytes}).`,
    )
  }
  if (size !== undefined && ctx.totalImageBytes + size > ctx.options.maxTotalImageBytes) {
    return omitImage(
      ctx,
      target,
      filename,
      `Image ${filename} was omitted because it exceeded the DOCX total image byte limit (${ctx.options.maxTotalImageBytes}).`,
    )
  }

  const ref = {
    target,
    filename,
    mime,
    index: ctx.images.length + 1,
    size,
  }
  ctx.images.push(ref)
  ctx.imageByTarget.set(target, ref)
  if (size !== undefined) ctx.totalImageBytes += size
  return `[Image ${ref.index}: ${filename}]`
}

async function relationshipsFor(entries: Map<string, Entry>, file: string) {
  const relationships = await readText(entries, relationshipFile(file))
  const ordered = relationships ? parseRelationships(relationships, path.posix.dirname(file)) : []
  return { ordered, byId: new Map(ordered.map((relationship) => [relationship.id, relationship])) }
}

function parseRelationships(xml: string, base: string) {
  return findAllByLocal(parseXml(xml), "Relationship").flatMap((node): Relationship[] => {
    const attrs = attributes(node)
    const id = stringValue(attrs.Id)
    const type = stringValue(attrs.Type)
    const target = stringValue(attrs.Target)
    if (!id || !type || !target) return []
    return [
      {
        id,
        type,
        mode: stringValue(attrs.TargetMode),
        target: target.startsWith("/")
          ? path.posix.normalize(target.slice(1))
          : path.posix.normalize(path.posix.join(base, target)),
      },
    ]
  })
}

function relationshipFile(file: string) {
  const dir = path.posix.dirname(file)
  return path.posix.join(dir, "_rels", `${path.posix.basename(file)}.rels`)
}

async function readText(entries: Map<string, Entry>, file: string) {
  const entry = entries.get(file)
  if (!entry?.getData || entry.directory) return ""
  return entry.getData(new TextWriter(), zipOptions)
}

async function readImage(ctx: ExtractContext, image: ImageRef) {
  if (timedOut(ctx)) {
    warn(
      ctx,
      `Image ${image.filename} was omitted because DOCX image extraction timed out after ${ctx.options.timeoutMs}ms.`,
    )
    return
  }

  const entry = ctx.entries.get(image.target)
  if (!entry?.getData || entry.directory) {
    warn(ctx, `Image ${image.filename} was omitted because it was missing from the DOCX package.`)
    return
  }

  try {
    const bytes = await promiseWithTimeout(
      entry.getData(new Uint8ArrayWriter(), zipOptions),
      timeRemaining(ctx),
      `Image ${image.filename} timed out after ${ctx.options.timeoutMs}ms.`,
    )
    if (image.size === undefined) {
      if (bytes.length > ctx.options.maxImageBytes) {
        warn(
          ctx,
          `Image ${image.filename} was omitted because it exceeded the per-image byte limit (${ctx.options.maxImageBytes}).`,
        )
        return
      }
      if (ctx.totalImageBytes + bytes.length > ctx.options.maxTotalImageBytes) {
        warn(
          ctx,
          `Image ${image.filename} was omitted because it exceeded the DOCX total image byte limit (${ctx.options.maxTotalImageBytes}).`,
        )
        return
      }
      ctx.totalImageBytes += bytes.length
    }
    if (image.size !== undefined && bytes.length > ctx.options.maxImageBytes) {
      ctx.totalImageBytes -= image.size
      warn(
        ctx,
        `Image ${image.filename} was omitted because it exceeded the per-image byte limit (${ctx.options.maxImageBytes}).`,
      )
      return
    }

    return {
      filename: image.filename,
      mime: image.mime,
      data: Buffer.from(bytes).toString("base64"),
      index: image.index,
    }
  } catch (error) {
    warn(
      ctx,
      `Image ${image.filename} was omitted because it could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function omitImage(ctx: ExtractContext, target: string, filename: string, warning: string) {
  warn(ctx, warning)
  const placeholder = `[Image omitted: ${filename}]`
  ctx.omittedByTarget.set(target, placeholder)
  return placeholder
}

function warn(ctx: ExtractContext, message: string) {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message)
}

function timedOut(ctx: ExtractContext) {
  return timeRemaining(ctx) <= 0
}

function timeRemaining(ctx: ExtractContext) {
  return ctx.options.timeoutMs - (Date.now() - ctx.started)
}

async function promiseWithTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  if (ms <= 0) throw new Error(message)

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function entrySize(entry: Entry) {
  const data = entry as Entry & { uncompressedSize?: unknown; size?: unknown }
  if (typeof data.uncompressedSize === "number") return data.uncompressedSize
  if (typeof data.size === "number") return data.size
}

function truncateText(text: string, ctx: ExtractContext) {
  if (text.length <= ctx.options.maxTextChars) return text
  warn(ctx, `DOCX text was truncated to ${ctx.options.maxTextChars} characters.`)
  return text.slice(0, ctx.options.maxTextChars)
}

function parseXml(xml: string): XmlNode[] {
  const parsed = parser.parse(xml)
  return Array.isArray(parsed) ? parsed.filter(record) : []
}

function findAllByLocal(nodes: XmlNode[], local: string): XmlNode[] {
  return nodes.flatMap((node) => [
    ...(localName(nodeName(node)) === local ? [node] : []),
    ...findAllByLocal(children(node), local),
  ])
}

function firstByLocal(nodes: XmlNode[], locals: string[]): XmlNode | undefined {
  for (const node of nodes) {
    if (locals.includes(localName(nodeName(node)))) return node
    const nested = firstByLocal(children(node), locals)
    if (nested) return nested
  }
}

function children(node: XmlNode | undefined) {
  if (!node) return [] as XmlNode[]
  const value = node[nodeName(node)]
  return Array.isArray(value) ? value.filter(record) : []
}

function nodeName(node: XmlNode | undefined) {
  return Object.keys(node ?? {}).find((key) => key !== ":@") ?? ""
}

function localName(name: string) {
  const index = name.indexOf(":")
  return index === -1 ? name : name.slice(index + 1)
}

function attributes(node: XmlNode) {
  const attrs = node[":@"]
  return record(attrs) ? attrs : {}
}

function textValue(node: XmlNode) {
  const value = node["#text"]
  return typeof value === "string" ? value : ""
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function imageMime(file: string) {
  const ext = path.posix.extname(file).slice(1).toLowerCase()
  return imageMimes.get(ext)
}

function record(value: unknown): value is XmlNode {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}
