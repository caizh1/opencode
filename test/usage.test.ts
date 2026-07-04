import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { estimateChatTokenUsage, normalizeProviderTokenUsage, normalizeTokenUsage, summarizeSessionUsage } from "../src/usage"
import type { ChipMateMessage, ChipMateModelInfo } from "../src/types"

describe("token usage summaries", () => {
  test("summarizes latest context, session totals, and remaining context", () => {
    const usage = summarizeSessionUsage({
      messages: [
        assistant("m1", { input: 10_000, output: 500, reasoning: 100, cost: 0.001 }),
        assistant("m2", { input: 24_100, output: 1_100, reasoning: 0, cost: 0.002 }),
      ],
      models: [model("deepseek/deepseek-v4-pro", 128_000)],
      selectedModel: "",
    })

    expect(usage.status).toBe("available")
    expect(usage.summary).toBe("Context 24.1k / 128k | 103.9k left est.")
    expect(usage.detail).toBe("Estimated context remaining: 103.9k tokens of 128k. Session 35.8k tokens | $0.003")
    expect(usage.level).toBe("normal")
    expect(usage.latest?.summary).toBe("24.1k in | 1.1k out | $0.002")
    expect(usage.total?.total).toBe(35_800)
  })

  test("uses selected model limit before assistant model metadata exists", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 81_000, output: 1000, reasoning: 0, providerID: "", modelID: "" })],
      models: [model("openai/gpt-5", 100_000)],
      selectedModel: "openai/gpt-5",
    })

    expect(usage.summary).toBe("Context 81k / 100k | 19k left est.")
    expect(usage.level).toBe("warning")
  })

  test("marks exhausted context estimates as errors", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 130_000, output: 1000, reasoning: 0 })],
      models: [model("openai/gpt-5", 128_000)],
      selectedModel: "openai/gpt-5",
    })

    expect(usage.summary).toBe("Context 130k / 128k | 0 left est.")
    expect(usage.level).toBe("error")
  })

  test("shows unknown limits and loaded-session totals when appropriate", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 24_100, output: 1100, reasoning: 0 })],
      models: [],
      selectedModel: "",
      loadedMessageLimit: 1,
    })

    expect(usage.summary).toBe("Context 24.1k | limit unknown")
    expect(usage.detail).toBe("Context 24.1k tokens used by the latest assistant turn input. Model context limit is unknown. Loaded session 25.2k tokens")
  })

  test("uses resolved chat context window override when provider model limits are unavailable", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 24_100, output: 1100, reasoning: 0 })],
      models: [],
      selectedModel: "",
      contextLimitOverride: { context: 262_144 },
    })

    expect(usage.summary).toBe("Context 24.1k / 262.1k | 238k left est.")
    expect(usage.detail).toBe("Estimated context remaining: 238k tokens of 262.1k. Session 25.2k tokens")
    expect(usage.detail).not.toContain("Model context limit is unknown")
  })

  test("does not show context zero for incomplete zero-token placeholders", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 0, output: 0, reasoning: 0 })],
      models: [],
      selectedModel: "",
    })

    expect(usage.status).toBe("pending")
    expect(usage.summary).toBe("Usage pending")
    expect(usage.summary).not.toContain("Context 0")
  })

  test("treats completed zero-token assistant usage as unavailable", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 0, output: 0, reasoning: 0, completed: true })],
      models: [],
      selectedModel: "",
    })

    expect(usage.status).toBe("unavailable")
    expect(usage.summary).toBe("Usage unavailable")
    expect(usage.summary).not.toContain("Context 0")
  })

  test("keeps output-only usage without rendering context zero", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 0, output: 1100, reasoning: 0 })],
      models: [model("deepseek/deepseek-v4-pro", 128_000)],
      selectedModel: "",
    })

    expect(usage.status).toBe("available")
    expect(usage.summary).toBe("Context unavailable")
    expect(usage.latest?.summary).toBe("1.1k out")
    expect(usage.summary).not.toContain("Context 0")
  })

  test("subtracts cache-read tokens from visible input and totals", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 120_000, output: 1_100, reasoning: 100, cacheRead: 90_000, total: 121_200 })],
      models: [model("deepseek/deepseek-v4-pro", 128_000)],
      selectedModel: "",
    })

    expect(usage.summary).toBe("Context 30k / 128k | 98k left est.")
    expect(usage.latest?.summary).toBe("30k in | 1.1k out | 100 reason")
    expect(usage.latest?.detail).toContain("90k cache read")
    expect(usage.total?.total).toBe(31_200)
  })

  test("ignores legacy accumulated reported usage that exceeds the model context", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 384_200, output: 1_300, reasoning: 399, total: 385_899 })],
      models: [model("deepseek/deepseek-v4-pro", 128_000)],
      selectedModel: "",
    })

    expect(usage.status).toBe("unavailable")
    expect(usage.summary).toBe("Usage unavailable")
  })

  test("distinguishes pending usage from old servers without token fields", () => {
    expect(summarizeSessionUsage({ messages: [], models: [], selectedModel: "" })).toMatchObject({
      status: "pending",
      summary: "Usage pending",
    })
    expect(
      summarizeSessionUsage({
        messages: [{ info: { id: "m1", role: "assistant" }, parts: [] }],
        models: [],
        selectedModel: "",
      }),
    ).toMatchObject({
      status: "unavailable",
      summary: "Usage unavailable",
    })
  })

  test("ignores malformed and negative token values", () => {
    expect(
      normalizeTokenUsage({
        input: -1,
        output: Number.NaN,
        reasoning: 4,
        cache: { read: -10, write: 2 },
      }),
    ).toEqual({
      total: undefined,
      input: undefined,
      output: undefined,
      reasoning: 4,
      cache: { read: undefined, write: 2 },
    })
    expect(normalizeTokenUsage({ input: -1, output: Number.NaN })).toBeUndefined()
  })

  test("normalizes provider usage chunks with reasoning and cache tokens", () => {
    expect(
      normalizeProviderTokenUsage({
        prompt_tokens: 120,
        completion_tokens: 34,
        total_tokens: 180,
        completion_tokens_details: { reasoning_tokens: 26 },
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({
      total: 180,
      input: 120,
      output: 34,
      reasoning: 26,
      cache: { read: 40, write: undefined },
    })
  })

  test("estimates chat usage from request messages and assistant text without storing content", () => {
    const usage = estimateChatTokenUsage({
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: [{ type: "text", text: "Explain local usage stats." }] },
      ],
      outputText: "Local usage stats are stored as aggregate counts.",
      model: "qwen3",
    })

    expect(usage.input).toBeGreaterThan(0)
    expect(usage.output).toBeGreaterThan(0)
    expect(usage.total).toBe((usage.input ?? 0) + (usage.output ?? 0))
  })

  test("keeps usage source and rendered strings free of mojibake separators", () => {
    const usage = summarizeSessionUsage({
      messages: [assistant("m1", { input: 24_100, output: 1100, reasoning: 0, cost: 0.002 })],
      models: [],
      selectedModel: "",
    })
    const badSeparators = new RegExp(`[${String.fromCharCode(183)}${String.fromCharCode(36335)}]`)
    const source = readFileSync(join(import.meta.dir, "..", "src", "usage.ts"), "utf8")

    expect(source).not.toMatch(badSeparators)
    expect(usage.summary).not.toMatch(badSeparators)
    expect(usage.detail).not.toMatch(badSeparators)
    expect(usage.latest?.summary).not.toMatch(badSeparators)
  })
})

function assistant(
  id: string,
  input: {
    input: number
    output: number
    reasoning: number
    cost?: number
    completed?: boolean
    providerID?: string
    modelID?: string
    cacheRead?: number
    total?: number
  },
): ChipMateMessage {
  return {
    info: {
      id,
      role: "assistant",
      providerID: input.providerID ?? "deepseek",
      modelID: input.modelID ?? "deepseek-v4-pro",
      cost: input.cost,
      time: input.completed ? { completed: 1 } : undefined,
      tokens: {
        input: input.input,
        output: input.output,
        reasoning: input.reasoning,
        total: input.total,
        cache: { read: input.cacheRead ?? 0, write: 0 },
      },
    },
    parts: [],
  }
}

function model(id: string, contextLimit: number): ChipMateModelInfo {
  const slash = id.indexOf("/")
  return {
    id,
    providerID: id.slice(0, slash),
    modelID: id.slice(slash + 1),
    name: id.slice(slash + 1),
    providerName: id.slice(0, slash),
    isDefault: false,
    contextLimit,
  }
}
