import { invokeCommandPalette, type RunContext } from "../environment.js"

export class CommentsPage {
  constructor(private readonly ctx: RunContext) {}

  async generateForCurrentFunction() {
    return invokeCommandPalette(this.ctx, "ChipMate: 为当前函数生成 AI 注释", this.ctx.config.timeouts.chatMs)
  }

  async generateForWorkspaceChanges() {
    return invokeCommandPalette(this.ctx, "ChipMate: 为工作区改动生成 AI 注释", this.ctx.config.timeouts.chatMs)
  }
}
