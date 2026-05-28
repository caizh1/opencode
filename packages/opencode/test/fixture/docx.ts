import { configure, TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"

const zipOptions = { useWebWorkers: false, useCompressionStream: false }

export const pngBytes = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  ),
)

export async function createDocx(entries?: Record<string, string | Uint8Array>) {
  configure(zipOptions)
  const writer = new ZipWriter(new Uint8ArrayWriter())
  const add = async (name: string, value: string | Uint8Array) => {
    await writer.add(name, typeof value === "string" ? new TextReader(value) : new Uint8ArrayReader(value))
  }

  for (const [name, value] of Object.entries({
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": `
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Left</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Right</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
          <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
        </w:body>
      </w:document>
    `,
    "word/_rels/document.xml.rels": `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
          Target="media/image1.png"/>
      </Relationships>
    `,
    "word/media/image1.png": pngBytes,
    ...(entries ?? {}),
  })) {
    await add(name, value)
  }

  return writer.close()
}
