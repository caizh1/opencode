import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeTokenUsage, summarizeSessionUsage } from "../src/usage"
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
        cache: { read: 0, write: 0 },
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
