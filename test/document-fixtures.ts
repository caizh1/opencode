import { deflateRawSync } from "node:zlib"

type ZipFile = {
  path: string
  data: Buffer
  method: 0 | 8
  compressed: Buffer
  localOffset: number
}

export function docxFixture(text: string) {
  const paragraphs = text.split(/\r?\n/).map((line) => (
    `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`
  )).join("")
  return zipFixture({
    "word/document.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      `<w:body>${paragraphs}</w:body>`,
      "</w:document>",
    ].join(""),
  }, 8)
}

export function xlsxFixture() {
  return zipFixture({
    "xl/workbook.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>',
      "</workbook>",
    ].join(""),
    "xl/_rels/workbook.xml.rels": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Relationships>",
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>',
      "</Relationships>",
    ].join(""),
    "xl/sharedStrings.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<sst>",
      "<si><t>Metric</t></si>",
      "<si><t>Count</t></si>",
      "<si><t>Boards</t></si>",
      "</sst>",
    ].join(""),
    "xl/worksheets/sheet1.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<worksheet><dimension ref="A1:C2"/><sheetData>',
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Formula</t></is></c></row>',
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c><c r="C2"><f>B2*2</f><v>6</v></c></row>',
      "</sheetData></worksheet>",
    ].join(""),
  }, 8)
}

export function xlsxRowsFixture(rowCount: number) {
  const rows = [
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>',
  ]
  for (let row = 2; row <= rowCount; row++) {
    rows.push(`<row r="${row}"><c r="A${row}" t="inlineStr"><is><t>Item ${row}</t></is></c><c r="B${row}"><v>${row}</v></c></row>`)
  }
  return zipFixture({
    "xl/workbook.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheets><sheet name="Rows" sheetId="1" r:id="rId1"/></sheets>',
      "</workbook>",
    ].join(""),
    "xl/_rels/workbook.xml.rels": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Relationships>",
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>',
      "</Relationships>",
    ].join(""),
    "xl/worksheets/sheet1.xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<worksheet><dimension ref="A1:B${rowCount}"/><sheetData>`,
      rows.join(""),
      "</sheetData></worksheet>",
    ].join(""),
  }, 8)
}

export function pdfFixture(text: string) {
  const content = `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`
  return Buffer.from([
    "%PDF-1.4",
    `1 0 obj << /Length ${Buffer.byteLength(content, "latin1")} >>`,
    "stream",
    content,
    "endstream",
    "endobj",
    "%%EOF",
  ].join("\n"), "latin1")
}

export function pdfWithoutTextFixture() {
  const content = "q 1 0 0 1 0 0 cm Q"
  return Buffer.from([
    "%PDF-1.4",
    `1 0 obj << /Length ${Buffer.byteLength(content, "latin1")} >>`,
    "stream",
    content,
    "endstream",
    "endobj",
    "%%EOF",
  ].join("\n"), "latin1")
}

function zipFixture(files: Record<string, string | Uint8Array>, method: 0 | 8) {
  const records: ZipFile[] = []
  let localOffset = 0
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    const compressed = method === 8 ? deflateRawSync(data) : data
    records.push({ path, data, method, compressed, localOffset })
    localOffset += 30 + Buffer.byteLength(path) + compressed.length
  }

  const centralOffset = localOffset
  const centralSize = records.reduce((sum, file) => sum + 46 + Buffer.byteLength(file.path), 0)
  const output = Buffer.alloc(centralOffset + centralSize + 22)
  let cursor = 0
  for (const file of records) {
    const name = Buffer.from(file.path)
    output.writeUInt32LE(0x04034b50, cursor)
    output.writeUInt16LE(20, cursor + 4)
    output.writeUInt16LE(0, cursor + 6)
    output.writeUInt16LE(file.method, cursor + 8)
    output.writeUInt32LE(0, cursor + 10)
    output.writeUInt32LE(0, cursor + 14)
    output.writeUInt32LE(file.compressed.length, cursor + 18)
    output.writeUInt32LE(file.data.length, cursor + 22)
    output.writeUInt16LE(name.length, cursor + 26)
    output.writeUInt16LE(0, cursor + 28)
    name.copy(output, cursor + 30)
    file.compressed.copy(output, cursor + 30 + name.length)
    cursor += 30 + name.length + file.compressed.length
  }
  for (const file of records) {
    const name = Buffer.from(file.path)
    output.writeUInt32LE(0x02014b50, cursor)
    output.writeUInt16LE(20, cursor + 4)
    output.writeUInt16LE(20, cursor + 6)
    output.writeUInt16LE(0, cursor + 8)
    output.writeUInt16LE(file.method, cursor + 10)
    output.writeUInt32LE(0, cursor + 12)
    output.writeUInt32LE(0, cursor + 16)
    output.writeUInt32LE(file.compressed.length, cursor + 20)
    output.writeUInt32LE(file.data.length, cursor + 24)
    output.writeUInt16LE(name.length, cursor + 28)
    output.writeUInt16LE(0, cursor + 30)
    output.writeUInt16LE(0, cursor + 32)
    output.writeUInt16LE(0, cursor + 34)
    output.writeUInt16LE(0, cursor + 36)
    output.writeUInt32LE(0, cursor + 38)
    output.writeUInt32LE(file.localOffset, cursor + 42)
    name.copy(output, cursor + 46)
    cursor += 46 + name.length
  }
  output.writeUInt32LE(0x06054b50, cursor)
  output.writeUInt16LE(0, cursor + 4)
  output.writeUInt16LE(0, cursor + 6)
  output.writeUInt16LE(records.length, cursor + 8)
  output.writeUInt16LE(records.length, cursor + 10)
  output.writeUInt32LE(centralSize, cursor + 12)
  output.writeUInt32LE(centralOffset, cursor + 16)
  output.writeUInt16LE(0, cursor + 20)
  return output
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function pdfEscape(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\n/g, "\\n")
}
