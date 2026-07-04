import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS,
  contextWindowFromProviderMetadata,
  resolveChatContextWindow,
} from "../src/context-window"

describe("chat context window resolver", () => {
  test("uses manual provider context length before all auto-detection paths", () => {
    const result = resolveChatContextWindow({
      configuredContextLength: 131072,
      model: "unknown-model",
      providerModels: { data: [{ id: "unknown-model", context_length: 8192 }] },
    })

    expect(result.modelContextWindow).toBe(131072)
    expect(result.source).toBe("configured")
    expect(result.fallbackNotice).toBeUndefined()
  })

  test("extracts provider metadata from OpenAI-compatible /models shapes", () => {
    expect(contextWindowFromProviderMetadata({
      data: [
        { id: "small", context_length: 4096 },
        { id: "target", limits: { context: 65536 } },
      ],
    }, "target")).toBe(65536)

    const result = resolveChatContextWindow({
      configuredContextLength: 0,
      model: "target",
      providerModels: { data: [{ id: "target", max_model_len: 98304 }] },
    })
    expect(result.modelContextWindow).toBe(98304)
    expect(result.source).toBe("provider_metadata")
  })

  test("uses the built-in public model table when provider metadata is unavailable", () => {
    const result = resolveChatContextWindow({
      configuredContextLength: 0,
      model: "gpt-4o",
      providerModels: { data: [] },
    })

    expect(result.modelContextWindow).toBe(128000)
    expect(result.source).toBe("builtin_table")
  })

  test("falls back to 262144 tokens with a degraded-but-safe user notice", () => {
    const result = resolveChatContextWindow({
      configuredContextLength: 0,
      model: "unknown-model",
      providerModels: { data: [] },
    })

    expect(result.modelContextWindow).toBe(DEFAULT_CHAT_CONTEXT_WINDOW_TOKENS)
    expect(result.source).toBe("fallback_default")
    expect(result.fallbackNotice).toContain("未能从模型元数据获取上下文长度")
    expect(result.fallbackNotice).toContain("262144")
    expect(result.fallbackNotice).toContain("chipmate.provider.contextLength")
  })
})
