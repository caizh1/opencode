import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

describe("extractPromptFromParts", () => {
  test("restores multiple uploaded attachments", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "check these",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_1",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AAA",
        filename: "a.png",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_2",
        type: "file",
        mime: "application/pdf",
        url: "data:application/pdf;base64,BBB",
        filename: "b.pdf",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: "text", content: "check these" })
    expect(result.slice(1)).toMatchObject([
      { type: "image", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      { type: "image", filename: "b.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBB" },
    ])
  })

  test("skips hidden DOCX model context attachments when restoring", () => {
    const parts = [
      {
        id: "text_1",
        type: "text",
        text: "Review this",
        sessionID: "ses_1",
        messageID: "msg_1",
      },
      {
        id: "file_docx",
        type: "file",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA",
        filename: "brief.docx",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: { opencodeDocx: { displayOnly: true, kind: "original" } },
      },
      {
        id: "file_image",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,BBB",
        filename: "image1.png",
        sessionID: "ses_1",
        messageID: "msg_1",
        metadata: { opencodeDocx: { hidden: true, modelContext: true, kind: "image" } },
      },
    ] satisfies Part[]

    const result = extractPromptFromParts(parts)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "text", content: "Review this" })
    expect(result[1]).toMatchObject({
      type: "image",
      id: "file_docx",
      filename: "brief.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAA",
    })
  })
})
