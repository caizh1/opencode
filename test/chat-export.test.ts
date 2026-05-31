import { describe, expect, test } from "bun:test"
import {
  buildExportIntentPrompt,
  exportMessagesForScope,
  formatChatExportMarkdown,
  isExportIntentCandidate,
  parseExplicitExportCommand,
  parseExportIntentResponse,
  suggestExportFilename,
} from "../src/chat-export"

describe("chat markdown export", () => {
  test("treats natural export wording as a model-classification candidate only", () => {
    expect(isExportIntentCandidate("请把这次对话导出为 markdown")).toBe(true)
    expect(isExportIntentCandidate("导出功能在哪里实现的？")).toBe(true)
    expect(parseExplicitExportCommand("导出功能在哪里实现的？")).toBeUndefined()
    expect(isExportIntentCandidate("where is the allocator implemented?")).toBe(false)
  })

  test("parses explicit slash export commands without model help", () => {
    expect(parseExplicitExportCommand("/export")).toEqual({ intent: "export", scope: "session" })
    expect(parseExplicitExportCommand("/export last")).toEqual({ intent: "export", scope: "lastAssistant" })
    expect(parseExplicitExportCommand("/export last hal notes.md")).toEqual({
      intent: "export",
      scope: "lastAssistant",
      filenameHint: "hal-notes",
    })
  })

  test("parses model export intent JSON and rejects invalid responses", () => {
    expect(parseExportIntentResponse('{"intent":"chat"}')).toEqual({ intent: "chat" })
    expect(parseExportIntentResponse('```json\n{"intent":"export","scope":"lastAssistant","filenameHint":"C:/tmp/hal.md"}\n```')).toEqual({
      intent: "export",
      scope: "lastAssistant",
      filenameHint: "hal",
    })
    expect(parseExportIntentResponse("not json")).toBeUndefined()
    expect(parseExportIntentResponse('{"intent":"maybe"}')).toBeUndefined()
  })

  test("formats full sessions and the latest assistant answer as markdown", () => {
    const messages = [
      { role: "user", text: "解释 **HAL**", timeCreated: 1_700_000_000 },
      { role: "assistant", text: "- BE\n- FE\n\n```c\nint x;\n```", timeCreated: 1_700_000_001 },
      { role: "error", text: "Temporary failure", timeCreated: 1_700_000_002 },
      { role: "tool", text: "internal tool detail", timeCreated: 1_700_000_003 },
      { role: "assistant", text: "最后回答", timeCreated: 1_700_000_004 },
    ]

    const full = formatChatExportMarkdown({
      messages,
      scope: "session",
      sessionTitle: "VS Code chat",
      exportedAt: new Date("2026-05-31T00:00:00.000Z"),
    })
    expect(full).toContain("# OpenCode Chat Export")
    expect(full).toContain("## User - 2023-11-14T22:13:20.000Z")
    expect(full).toContain("## Assistant - 2023-11-14T22:13:21.000Z")
    expect(full).toContain("```c\nint x;\n```")
    expect(full).toContain("## Error - 2023-11-14T22:13:22.000Z")
    expect(full).not.toContain("internal tool detail")

    const last = formatChatExportMarkdown({
      messages,
      scope: "lastAssistant",
      exportedAt: new Date("2026-05-31T00:00:00.000Z"),
    })
    expect(last).toContain("Scope: Last assistant response")
    expect(last).toContain("最后回答")
    expect(last).not.toContain("```c")
  })

  test("returns empty markdown when no selected export content exists", () => {
    expect(formatChatExportMarkdown({ messages: [], scope: "session" })).toBe("")
    expect(formatChatExportMarkdown({ messages: [{ role: "user", text: "hello" }], scope: "lastAssistant" })).toBe("")
    expect(exportMessagesForScope([{ role: "assistant", text: "ok" }], "lastAssistant")).toHaveLength(1)
  })

  test("builds classifier prompts and safe markdown filenames", () => {
    const prompt = buildExportIntentPrompt({
      userRequest: "保存最后一个回答为 md",
      sessionTitle: "HAL notes",
      messages: [{ role: "assistant", text: "answer" }],
    })
    expect(prompt).toContain('"intent":"export"|"chat"')
    expect(prompt).toContain('Use intent "chat" when the user asks about export code')
    expect(prompt).toContain("HAL notes")

    expect(
      suggestExportFilename({
        filenameHint: "../bad:path?.md",
        exportedAt: new Date("2026-05-31T00:00:00.000Z"),
      }),
    ).toBe("bad-path.md")
    expect(
      suggestExportFilename({
        sessionTitle: "VS Code chat",
        exportedAt: new Date("2026-05-31T00:00:00.000Z"),
      }),
    ).toBe("VS-Code-chat-2026-05-31-00-00-00.md")
  })
})
