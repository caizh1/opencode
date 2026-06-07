import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const FORBIDDEN_PRODUCTION_STRINGS = [
  "nfdrv_wait_nfc_clk_reset",
  "nfc_aes_for_no_meta_get",
  "nfc_cdma_desc_zero_init",
  "//step2. wait nfc clock rest",
]

describe("completion production code anti-hardcode guard", () => {
  test("keeps fixture-only symbols and comments out of production sources", () => {
    const hits: string[] = []
    for (const file of sourceFiles(join(import.meta.dir, "..", "src"))) {
      const text = readFileSync(file, "utf8")
      for (const forbidden of FORBIDDEN_PRODUCTION_STRINGS) {
        if (text.includes(forbidden)) hits.push(`${file}: ${forbidden}`)
      }
    }

    expect(hits).toEqual([])
  })
})

function sourceFiles(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      result.push(...sourceFiles(path))
    } else if (/\.[cm]?tsx?$/.test(path)) {
      result.push(path)
    }
  }
  return result
}
