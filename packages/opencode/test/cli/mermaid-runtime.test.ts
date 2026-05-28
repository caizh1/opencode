import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { mmdcShimContent, writeMmdcShim } from "../../script/prepare-mermaid-runtime"

describe("mermaid runtime", () => {
  test("writes a standalone mmdc shim for the runtime archive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mermaid-runtime-"))
    try {
      const shim = await writeMmdcShim(dir)
      const content = await fs.readFile(shim, "utf8")

      expect(path.relative(dir, shim).replaceAll("\\", "/")).toBe("mmdc")
      expect(content).toContain("runtime_dir=\"$bin_dir/mermaid-cli\"")
      expect(content).toContain("mmdc=\"$runtime_dir/node_modules/.bin/mmdc\"")
      expect(content).toContain("--puppeteerConfigFile")
      expect(content).toContain("--no-sandbox")
      if (process.platform !== "win32") expect((await fs.stat(shim)).mode & 0o111).not.toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("mmdc shim respects user-provided puppeteer config", () => {
    expect(mmdcShimContent()).toContain("-p|--puppeteerConfigFile|--puppeteerConfigFile=*")
  })
})
