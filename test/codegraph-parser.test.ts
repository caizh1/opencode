import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"

describe("C code graph parser", () => {
  test("extracts includes, macros, functions, and calls", () => {
    const parsed = parseCFile({
      path: "drivers/nand/nand.c",
      hash: "abc",
      size: 1,
      text: `
#include "nand.h"
#include <stdint.h>
#define NAND_PAGE_SIZE 4096

static int nand_wait_ready(void)
{
  return poll_status();
}

int nand_read_page(struct nand_chip *chip, uint32_t page)
{
  // fake_call();
  const char *label = "string_call()";
  nand_wait_ready();
  dma_submit(page);
  return ecc_check(chip);
}
`,
    })

    expect(parsed.includes.map((item) => item.target)).toEqual(["nand.h", "stdint.h"])
    expect(parsed.macros.map((item) => item.name)).toContain("NAND_PAGE_SIZE")
    expect(parsed.functions.map((item) => item.name)).toEqual(["nand_wait_ready", "nand_read_page"])
    expect(parsed.functions[0].isStatic).toBe(true)
    const readPage = parsed.functions.find((item) => item.name === "nand_read_page")
    expect(readPage?.calls.map((call) => call.name)).toEqual(["nand_wait_ready", "dma_submit", "ecc_check"])
  })

  test("handles multi-line signatures", () => {
    const parsed = parseCFile({
      path: "src/io.c",
      hash: "def",
      size: 1,
      text: `
int
storage_submit(
  struct request *req,
  int flags
)
{
  return queue_request(req, flags);
}
`,
    })

    expect(parsed.functions).toHaveLength(1)
    expect(parsed.functions[0].name).toBe("storage_submit")
    expect(parsed.functions[0].signature).toContain("storage_submit")
    expect(parsed.functions[0].calls.map((call) => call.name)).toEqual(["queue_request"])
  })
})
