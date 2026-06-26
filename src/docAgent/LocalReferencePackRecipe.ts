import type { DocumentRecipe } from "./DocumentRecipeRegistry"

export class LocalReferencePackRecipe implements DocumentRecipe {
  readonly id = "local-reference-pack"
  readonly name = "Local Reference Pack"

  async match(input: { question: string }) {
    const matched = /(?:生成|整合|综合|汇总).*(?:文档|word|docx|规范|指南)/i.test(input.question)
    return { matched, score: matched ? 0.4 : 0 }
  }
}
