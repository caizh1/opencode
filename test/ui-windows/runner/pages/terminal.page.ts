import { invokeCommandPalette, type RunContext } from "../environment.js"

export class TerminalPage {
  constructor(private readonly ctx: RunContext) {}

  async openAgentTerminal() {
    return invokeCommandPalette(this.ctx, "ChipMate: Open ChipMate Agent Terminal", 2000)
  }
}
