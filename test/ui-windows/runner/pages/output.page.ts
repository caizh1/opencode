import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { invokeCommandPalette, type RunContext } from "../environment.js"

export class OutputPage {
  constructor(private readonly ctx: RunContext) {}

  async openChipMateOutput() {
    return invokeCommandPalette(this.ctx, "ChipMate: Open ChipMate Output")
  }

  async text() {
    const candidates = [
      join(this.ctx.logsDir, "chipmate-output.log"),
      join(this.ctx.logsDir, "chipmate-comment-output.log"),
      join(this.ctx.logsDir, "extension-host.log"),
    ]
    const chunks: string[] = []
    for (const file of candidates) {
      if (existsSync(file)) chunks.push(await readFile(file, "utf8"))
    }
    return chunks.join("\n")
  }
}
