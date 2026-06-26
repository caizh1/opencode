import { invokeCommandPalette, submitTextToActiveVsCodeInput, type RunContext } from "../environment.js"

export class ChatPage {
  constructor(private readonly ctx: RunContext) {}

  async open() {
    return invokeCommandPalette(this.ctx, "ChipMate: Open ChipMate Chat")
  }

  async newSession() {
    return invokeCommandPalette(this.ctx, "ChipMate: New ChipMate Session")
  }

  async openOutput() {
    return invokeCommandPalette(this.ctx, "ChipMate: Open ChipMate Output")
  }

  async askCurrentFile(question: string) {
    const command = await invokeCommandPalette(this.ctx, "ChipMate: Ask ChipMate About Current File", 700)
    const input = await submitTextToActiveVsCodeInput(this.ctx, "ask-current-file-question", question, 1500)
    return `${command}; ${input}`
  }

  async sendPromptByCommandPaletteFallback() {
    await this.open()
    return `Opened ChipMate chat for ${this.ctx.workspace}`
  }
}
