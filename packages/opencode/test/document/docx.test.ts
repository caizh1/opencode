import { describe, expect, test } from "bun:test"
import { extractDocx, formatDocxForModel } from "../../src/document/docx"
import { createDocx, pngBytes } from "../fixture/docx"

describe("document.docx", () => {
  test("extracts text, tables, and related images", async () => {
    const docx = await extractDocx(await createDocx())

    expect(docx.text).toContain("Hello World")
    expect(docx.text).toContain("Left | Right")
    expect(docx.text).toContain("[Image 1: image1.png]")
    expect(docx.images).toHaveLength(1)
    expect(docx.images[0]).toMatchObject({
      filename: "image1.png",
      mime: "image/png",
      index: 1,
      data: Buffer.from(pngBytes).toString("base64"),
    })
  })

  test("includes related headers in formatted model text", async () => {
    const docx = await extractDocx(
      await createDocx({
        "word/document.xml": `
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body>
          </w:document>
        `,
        "word/_rels/document.xml.rels": `
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1"
              Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"
              Target="header1.xml"/>
          </Relationships>
        `,
        "word/header1.xml": `
          <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:p><w:r><w:t>Header text</w:t></w:r></w:p>
          </w:hdr>
        `,
      }),
    )

    expect(formatDocxForModel({ filename: "brief.docx", docx })).toContain("## Header\n\nHeader text")
  })
})
