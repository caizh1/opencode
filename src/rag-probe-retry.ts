import { RagHttpError } from "./rag-provider"

export type RagEmbeddingProbeRetrySettings = {
  resumeDelayMs: number
  retryBackoffMs: number
}

export type RagEmbeddingProbeRetryDecision =
  | { retry: true; status: number; delayMs: number }
  | { retry: false }

export function ragEmbeddingProbeRetryDecision(error: unknown, settings: RagEmbeddingProbeRetrySettings): RagEmbeddingProbeRetryDecision {
  if (!(error instanceof RagHttpError)) return { retry: false }
  if (!isTransientRagProbeStatus(error.status)) return { retry: false }
  const fallbackDelayMs = Math.max(0, Math.floor(settings.resumeDelayMs || settings.retryBackoffMs))
  const delayMs = error.status === 429 && error.retryAfterMs !== undefined
    ? Math.max(0, Math.floor(error.retryAfterMs))
    : fallbackDelayMs
  return { retry: true, status: error.status, delayMs }
}

function isTransientRagProbeStatus(status: number) {
  return status === 429 || status === 408 || (status >= 500 && status <= 599)
}
