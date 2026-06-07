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
typedef unsigned int nand_page_t;
struct nand_chip {
  int ready;
};
static int nand_debug_level;

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
    expect(parsed.types.map((item) => item.name)).toContain("nand_page_t")
    expect(parsed.types.map((item) => item.name)).toContain("nand_chip")
    expect(parsed.globals.map((item) => item.name)).toContain("nand_debug_level")
    expect(parsed.tokens.some((item) => item.kind === "comment" && item.term === "fake")).toBe(true)
    expect(parsed.tokens.some((item) => item.kind === "macro" && item.term === "nand")).toBe(true)
    expect(parsed.functions.map((item) => item.name)).toEqual(["nand_wait_ready", "nand_read_page"])
    expect(parsed.functions[0].isStatic).toBe(true)
    const readPage = parsed.functions.find((item) => item.name === "nand_read_page")
    expect(readPage?.calls.map((call) => call.name)).toEqual(["nand_wait_ready", "dma_submit", "ecc_check"])
    expect(parsed.types.find((item) => item.name === "nand_chip")?.fields?.map((field) => field.name)).toContain("ready")
    expect(readPage?.calls.find((call) => call.name === "dma_submit")?.args).toEqual(["page"])
    expect(readPage?.calls.find((call) => call.name === "ecc_check")?.returnHandling).toBe("return")
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

  test("extracts completion evidence for C embedded fields, call sites, initializers, error labels, and register macro families", () => {
    const parsed = parseCFile({
      path: "drivers/uart/uart.c",
      hash: "evidence",
      size: 1,
      text: `
#define UART_CTRL_REG 0x00u
#define UART_CTRL_ENABLE BIT(0)
#define UART_CTRL_ENABLE_MASK GENMASK(0, 0)
typedef void (*driver_cb_t)(uint32_t event);
static void driver_on_event(uint32_t event) { (void)event; }
typedef struct { driver_cb_t on_event; uint32_t mask; } driver_ops_t;
static const driver_ops_t default_ops = { .on_event = driver_on_event, .mask = BIT(0), };

int driver_probe(struct device *dev)
{
  int ret = driver_lock(dev);
  if (ret) {
    goto out_unlock;
  }
  ret = driver_start(dev, &default_ops);
  if (ret) {
    goto out_unlock;
  }
  return 0;
out_unlock:
  driver_unlock(dev);
  return ret;
}
`,
    })

    expect(parsed.types.find((item) => item.name === "driver_ops_t")?.fields?.map((field) => field.name)).toEqual(["on_event", "mask"])
    expect(parsed.callSites.find((item) => item.callee === "driver_start")).toMatchObject({
      caller: "driver_probe",
      args: ["dev", "&default_ops"],
      returnHandling: "assignment:ret",
    })
    expect(parsed.initializers[0]).toMatchObject({
      typeName: "driver_ops_t",
      fields: ["on_event", "mask"],
    })
    expect(parsed.errorLabels.find((item) => item.name === "out_unlock")).toMatchObject({
      functionName: "driver_probe",
      cleanupCalls: ["driver_unlock"],
      returnStyle: "return ret;",
    })
    expect(parsed.registerMacroFamilies.find((item) => item.family === "UART_CTRL")?.macros.map((item) => item.name)).toEqual([
      "UART_CTRL_REG",
      "UART_CTRL_ENABLE",
      "UART_CTRL_ENABLE_MASK",
    ])
  })
})
