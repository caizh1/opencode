import { describe, expect, test } from "bun:test"
import { CodeGraphWorkerPool } from "../src/codegraph-worker-host"

describe("code graph worker pool", () => {
  test("falls back to parser output when worker threads are not compiled for the test runtime", async () => {
    const pool = new CodeGraphWorkerPool()
    try {
      const status = await pool.health(2)
      const file = await pool.parseFile({
        path: "drivers/nand/nand.c",
        hash: "1",
        size: 1,
        text: `int ecc_check(void) { return 0; }\nint nand_read_page(void) { return ecc_check(); }\n`,
      }, 2)

      expect(status.workers).toBeGreaterThanOrEqual(0)
      expect(file.functions.map((fn) => fn.name)).toContain("nand_read_page")
    } finally {
      pool.dispose()
    }
  })
})
