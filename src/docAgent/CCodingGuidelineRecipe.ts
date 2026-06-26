import type { DocumentRecipe } from "./DocumentRecipeRegistry"

export class CCodingGuidelineRecipe implements DocumentRecipe {
  readonly id = "c-coding-guideline"
  readonly name = "C Coding Guideline Recipe"

  async match(input: { question: string }) {
    const text = input.question
    const guideline = /(?:c\s*语言|c\s*编码|c coding|coding standard|编码规范|编码指南|安全编码规范)/i.test(text)
    const output = /(?:生成|整合|综合|汇总).*(?:文档|word|docx|规范|指南)/i.test(text)
    return { matched: guideline && output, score: guideline && output ? 0.95 : 0 }
  }
}
