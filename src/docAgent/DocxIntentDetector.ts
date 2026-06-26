export type DocxIntentDetection = {
  matched: boolean
  reason?: string
  needsAtLeastDocx: number
}

const WORD_OUTPUT_PATTERNS = [
  /生成.*(?:word|docx|文档|规范)/i,
  /整合.*(?:word|docx|文档|规范|资料)/i,
  /综合.*(?:资料|规范).*生成/i,
  /汇总.*(?:word|docx|文档|规范)/i,
]

const GUIDELINE_PATTERNS = [
  /(?:c\s*语言|c\s*编码|c coding|coding standard|编码规范|编码指南|安全编码规范)/i,
  /(?:团队.*规范|公司.*规范|内部.*规范)/i,
]

export class DocxIntentDetector {
  detect(input: { text: string; docxCount: number }): DocxIntentDetection {
    const text = input.text.trim()
    const wantsWordOutput = WORD_OUTPUT_PATTERNS.some((pattern) => pattern.test(text))
    const wantsGuideline = GUIDELINE_PATTERNS.some((pattern) => pattern.test(text))
    if (!wantsWordOutput || !wantsGuideline) return { matched: false, needsAtLeastDocx: 2 }
    if (input.docxCount < 2) {
      return {
        matched: true,
        reason: "请至少 @ 两份 .docx：公司内部 C 编码规范 + 外部参考规范资料。",
        needsAtLeastDocx: 2,
      }
    }
    return { matched: true, needsAtLeastDocx: 2 }
  }
}
