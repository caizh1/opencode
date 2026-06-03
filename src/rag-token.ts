export const RAG_EMBEDDING_MAX_TOKENS_PER_REQUEST_DEFAULT = 65536

export function estimateEmbeddingTokens(text: string) {
  if (!text) return 1
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) <= 0x7f) ascii++
    else nonAscii++
  }
  return Math.max(1, Math.ceil(ascii / 3.5 + nonAscii))
}
