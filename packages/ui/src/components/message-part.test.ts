import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"
import { readToolStatusTitle, readToolTrigger } from "./read-tool-trigger"

const i18n = {
  t: (key: string) =>
    ({
      "ui.tool.read": "读取",
      "ui.tool.read.running": "读取中",
      "ui.tool.read.completed": "已读取",
      "ui.tool.read.error": "读取失败",
    })[key] ?? key,
} as any

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("readToolTrigger", () => {
  test("shows running state and filename while reading", () => {
    expect(
      readToolTrigger(
        { filePath: "C:\\workspace\\docs\\brief.docx", offset: 10, limit: 20 },
        "running",
        undefined,
        i18n,
      ),
    ).toEqual({
      title: "读取中",
      subtitle: "brief.docx",
      args: ["offset=10", "limit=20"],
    })
  })

  test("shows completed state and filename", () => {
    expect(readToolTrigger({ filePath: "/workspace/docs/brief.docx" }, "completed", undefined, i18n)).toMatchObject({
      title: "已读取",
      subtitle: "brief.docx",
    })
  })

  test("shows error state", () => {
    expect(readToolStatusTitle("error", i18n)).toBe("读取失败")
  })

  test("falls back to completed title when input path is missing", () => {
    expect(readToolTrigger({}, "completed", "docs/fallback.docx", i18n)).toMatchObject({
      title: "已读取",
      subtitle: "fallback.docx",
    })
  })

  test("handles missing input path without a placeholder", () => {
    expect(readToolTrigger({}, "pending", undefined, i18n)).toEqual({
      title: "读取中",
      subtitle: "",
      args: [],
    })
  })
})
