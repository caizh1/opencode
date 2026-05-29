import { describe, expect, test } from "bun:test"
import { buildMentionIndex, normalizeMentionQuery, searchMentionIndex } from "../src/mention-index"

describe("mention index", () => {
  const entries = buildMentionIndex([
    { uri: "file:///repo/source/ssd_fw/be/bm/gc/bm_gc_alg_dfx.c", label: "source\\ssd_fw\\be\\bm\\gc\\bm_gc_alg_dfx.c" },
    { uri: "file:///repo/source/ssd_fw/be/bm/gc/bm_gc_alg.c", label: "source/ssd_fw/be/bm/gc/bm_gc_alg.c" },
    { uri: "file:///repo/src/chat-view.ts", label: "src/chat-view.ts" },
  ])

  test("normalizes Windows and Unix path separators", () => {
    expect(normalizeMentionQuery("@source\\ssd_fw\\be")).toBe("source/ssd_fw/be")
  })

  test("finds files in deep directories", () => {
    const results = searchMentionIndex(entries, "source/ssd_fw/be/bm/gc", 10)

    expect(results.some((item) => item.type === "file" && item.label.endsWith("bm_gc_alg_dfx.c"))).toBe(true)
  })

  test("returns folder suggestions for path navigation", () => {
    const results = searchMentionIndex(entries, "source/ssd_fw/be/bm/", 10)

    expect(results[0]).toMatchObject({
      type: "folder",
      label: "source/ssd_fw/be/bm/gc",
      insertText: "source/ssd_fw/be/bm/gc/",
    })
  })
})
