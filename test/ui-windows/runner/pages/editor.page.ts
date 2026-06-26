import { join } from "node:path"
import { invokeCommandPalette, openFile, type RunContext } from "../environment.js"

export class EditorPage {
  constructor(private readonly ctx: RunContext) {}

  openSmokeFile() {
    return openFile(this.ctx, join(this.ctx.workspace, "src", "main.c"), 4, 16)
  }

  openFullDriverFile() {
    return openFile(this.ctx, join(this.ctx.workspace, "src", "driver.c"), 19, 5)
  }

  async triggerInlineCompletion() {
    return invokeCommandPalette(this.ctx, "Trigger Inline Suggestion", 2500)
  }

  async regenerateInlineCompletion() {
    return invokeCommandPalette(this.ctx, "ChipMate: Regenerate ChipMate Inline Completion", 2500)
  }
}
