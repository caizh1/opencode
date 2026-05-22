import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export type ProviderHealth = {
  connected: boolean
  latencyMs: number | null
}

export type ProvidersHealth = Record<string, ProviderHealth>

export async function checkProvidersHealth(sdk: OpencodeClient): Promise<ProvidersHealth> {
  try {
    const res = await sdk.provider.ping()
    if (res.error) {
      console.error("[provider-health] ping error:", res.error)
      return {}
    }
    return (res.data ?? {}) as ProvidersHealth
  } catch (err) {
    console.error("[provider-health] ping failed:", err)
    return {}
  }
}
