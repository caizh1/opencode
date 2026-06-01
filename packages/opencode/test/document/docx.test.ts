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

  test("limits embedded images and records warnings", async () => {
    const ids = Array.from({ length: 4 }, (_, i) => i + 1)
    const docx = await extractDocx(
      await createDocx({
        "word/document.xml": `
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <w:body>
              ${ids.map((id) => `<w:p><w:r><w:drawing><a:blip r:embed="rId${id}"/></w:drawing></w:r></w:p>`).join("")}
            </w:body>
          </w:document>
        `,
        "word/_rels/document.xml.rels": `
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            ${ids
              .map(
                (id) => `<Relationship Id="rId${id}"
                  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
                  Target="media/image${id}.png"/>`,
              )
              .join("")}
          </Relationships>
        `,
        ...Object.fromEntries(ids.map((id) => [`word/media/image${id}.png`, pngBytes])),
      }),
      { maxImages: 2 },
    )

    expect(docx.images).toHaveLength(2)
    expect(docx.text).toContain("[Image 1: image1.png]")
    expect(docx.text).toContain("[Image 2: image2.png]")
    expect(docx.text).toContain("[Image omitted: image3.png]")
    expect(docx.warnings.join("\n")).toContain("image count limit (2)")
  })

  test("deduplicates repeated image relationship targets", async () => {
    const docx = await extractDocx(
      await createDocx({
        "word/document.xml": `
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <w:body>
              <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
              <w:p><w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r></w:p>
            </w:body>
          </w:document>
        `,
        "word/_rels/document.xml.rels": `
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1"
              Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
              Target="media/image1.png"/>
            <Relationship Id="rId2"
              Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
              Target="media/image1.png"/>
          </Relationships>
        `,
      }),
    )

    expect(docx.images).toHaveLength(1)
    expect(docx.text.match(/\[Image 1: image1\.png\]/g)).toHaveLength(2)
  })

  test("skips oversized images and keeps text readable", async () => {
    const docx = await extractDocx(await createDocx({ "word/media/image1.png": new Uint8Array([1, 2, 3, 4]) }), {
      maxImageBytes: 3,
    })

    expect(docx.images).toHaveLength(0)
    expect(docx.text).toContain("Hello World")
    expect(docx.text).toContain("[Image omitted: image1.png]")
    expect(docx.warnings.join("\n")).toContain("per-image byte limit (3)")
  })

  test("truncates extracted text at the configured limit", async () => {
    const docx = await extractDocx(
      await createDocx({
        "word/document.xml": `
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body><w:p><w:r><w:t>${"x".repeat(20)}</w:t></w:r></w:p></w:body>
          </w:document>
        `,
      }),
      { maxTextChars: 5 },
    )

    expect(docx.text).toBe("x".repeat(5))
    expect(docx.warnings.join("\n")).toContain("truncated to 5 characters")
  })
})
