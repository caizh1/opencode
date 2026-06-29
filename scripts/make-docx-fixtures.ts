import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { WordDocBuilder } from "../src/docAgent/WordDocBuilder"
import type { WordDocSpec } from "../src/docAgent/types"

type FixtureManifestItem = {
  name: string
  path: string
  description: string
  features: string[]
}

async function main() {
  const outDir = outputDirFromArgs(process.argv.slice(2))
  await mkdir(outDir, { recursive: true })
  const fixtures: FixtureManifestItem[] = []

  const watermark = await multipartWatermarkFixture()
  await writeFixture(outDir, "watermark-multipart.docx", watermark)
  fixtures.push({
    name: "watermark-multipart",
    path: "watermark-multipart.docx",
    description: "VML textpath watermarks across header and footer story parts.",
    features: ["vml-watermark", "header-part", "footer-part"],
  })

  const tracked = await trackedChangeFixture()
  await writeFixture(outDir, "tracked-change-basic.docx", tracked)
  fixtures.push({
    name: "tracked-change-basic",
    path: "tracked-change-basic.docx",
    description: "Minimal Word revision markup with adjacent deletion and insertion runs.",
    features: ["tracked-change", "w:del", "w:ins"],
  })

  const fields = await fieldAndCaptionFixture()
  await writeFixture(outDir, "fields-captions-crossrefs.docx", fields)
  fixtures.push({
    name: "fields-captions-crossrefs",
    path: "fields-captions-crossrefs.docx",
    description: "Caption SEQ fields plus REF/PAGEREF cross-reference fields.",
    features: ["caption", "SEQ", "REF", "PAGEREF", "bookmark"],
  })

  const manifest = {
    generatedAt: new Date().toISOString(),
    fixtureVersion: 1,
    generator: "scripts/make-docx-fixtures.ts",
    fixtures,
  }
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  console.log(`Generated ${fixtures.length} DOCX fixture(s) in ${outDir}`)
  for (const fixture of fixtures) console.log(`- ${fixture.path}: ${fixture.features.join(", ")}`)
}

function outputDirFromArgs(args: string[]) {
  const outIndex = args.findIndex((arg) => arg === "--out" || arg === "-o")
  const value = outIndex >= 0 ? args[outIndex + 1] : args[0]
  return path.resolve(value || path.join(process.cwd(), ".chipmate", "docs", "fixtures"))
}

async function writeFixture(outDir: string, filename: string, bytes: Uint8Array) {
  await writeFile(path.join(outDir, filename), bytes)
}

async function multipartWatermarkFixture() {
  let bytes = await new WordDocBuilder().build(baseSpec("Watermark Multipart Fixture", [{
    id: "overview",
    level: 1,
    title: "Watermark Fixture",
    paragraphs: ["This fixture contains VML textpath watermarks in multiple Word story parts."],
  }]))
  bytes = await replaceZipText(bytes, "word/header1.xml", (xml) => insertBeforeClosing(xml, "w:hdr", vmlWatermarkParagraph("HEADER DEFAULT")))
  bytes = await writeZipText(bytes, "word/header2.xml", storyPartXml("hdr", vmlWatermarkParagraph("HEADER SECOND")))
  bytes = await writeZipText(bytes, "word/footer1.xml", storyPartXml("ftr", vmlWatermarkParagraph("FOOTER DEFAULT")))
  return bytes
}

async function trackedChangeFixture() {
  let bytes = await new WordDocBuilder().build(baseSpec("Tracked Change Fixture", [{
    id: "tracked",
    level: 1,
    title: "Tracked Change Fixture",
    paragraphs: ["Original tracked text."],
  }]))
  bytes = await replaceZipText(bytes, "word/document.xml", (xml) => xml.replace(
    /<w:r>[\s\S]*?<w:t xml:space="preserve">Original tracked text\.<\/w:t>[\s\S]*?<\/w:r>/,
    [
      '<w:del w:id="1" w:author="ChipMate Fixture" w:date="2026-06-28T00:00:00Z"><w:r><w:delText xml:space="preserve">Original tracked text.</w:delText></w:r></w:del>',
      '<w:ins w:id="2" w:author="ChipMate Fixture" w:date="2026-06-28T00:00:00Z"><w:r><w:t xml:space="preserve">Revised tracked text.</w:t></w:r></w:ins>',
    ].join(""),
  ))
  return bytes
}

async function fieldAndCaptionFixture() {
  const spec = baseSpec("Fields Captions Crossrefs Fixture", [
    {
      id: "target",
      level: 1,
      title: "Referenced Section",
      bookmark: "sec_target",
      paragraphs: ["This section is referenced by REF and PAGEREF fields."],
      figures: [{
        id: "fig-one",
        title: "Fixture Figure",
        caption: "Fixture figure caption.",
        label: "Figure",
        bookmark: "fig_fixture",
        altText: "Fixture PNG",
        image: { contentType: "image/png", bytes: tinyPngBytes(), width: 80, height: 40 },
      }],
      tables: [{
        headers: ["Item", "Value"],
        rows: [["alpha", "1"]],
        caption: "Fixture table caption.",
        label: "Table",
        bookmark: "tbl_fixture",
      }],
    },
    {
      id: "refs",
      level: 1,
      title: "References",
      richParagraphs: [{
        runs: [{ text: "See {{ref:sec_target|Referenced Section}} on page {{pageref:sec_target|3}}." }],
      }],
    },
  ])
  return await new WordDocBuilder().build(spec)
}

function baseSpec(title: string, sections: WordDocSpec["sections"]): WordDocSpec {
  return {
    metadata: {
      title,
      documentType: "docx-regression-fixture",
      language: "en-US",
      generatedAt: "2026-06-28T00:00:00.000Z",
      author: "ChipMate Fixture Generator",
    },
    layout: { preset: "technical_spec", navigation: { mode: "none" } },
    cover: { title, subtitle: "Generated DOCX regression fixture", preparedBy: "ChipMate" },
    sections,
    references: [],
    qualityChecklist: {
      assumptions: ["Generated locally for regression testing."],
      limitations: ["Fixtures are intentionally small and target specific OOXML patterns."],
      missingInputs: [],
      risks: [],
    },
  }
}

async function replaceZipText(bytes: Uint8Array, partPath: string, replace: (xml: string) => string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  const part = zip.file(partPath)
  if (!part) throw new Error(`Missing DOCX part: ${partPath}`)
  zip.file(partPath, replace(await part.async("string")))
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

async function writeZipText(bytes: Uint8Array, partPath: string, content: string) {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(Buffer.from(bytes))
  zip.file(partPath, content)
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

function insertBeforeClosing(xml: string, tag: string, content: string) {
  const closing = `</${tag}>`
  return xml.includes(closing) ? xml.replace(closing, `${content}${closing}`) : xml
}

function storyPartXml(root: "hdr" | "ftr", content: string) {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${root} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">`,
    content,
    `</w:${root}>`,
  ].join("")
}

function vmlWatermarkParagraph(text: string) {
  return [
    "<w:p><w:r><w:pict>",
    `<v:shape id="fixture-${safeXmlAttr(text)}" o:spid="_x0000_s1025" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:468pt;height:468pt;rotation:315;z-index:-251654144" fillcolor="#C0C0C0" stroked="f">`,
    '<v:fill opacity="0.15"/>',
    `<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${safeXmlAttr(text)}"/>`,
    '<v:path textpathok="t"/>',
    "</v:shape>",
    "</w:pict></w:r></w:p>",
  ].join("")
}

function safeXmlAttr(input: string) {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function tinyPngBytes() {
  return Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAACjPQP+fXfW4QAAAABJRU5ErkJggg==", "base64"))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
