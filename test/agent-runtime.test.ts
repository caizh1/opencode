import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "../src/agent-runtime"
import type { OpenAIChatCompletionResult, OpenAIChatMessage, OpenAIChatToolCall } from "../src/openai-chat-client"

describe("AgentRuntime", () => {
  test("runs a no-tool chat request and returns the assistant message", async () => {
    const client = fakeClient([
      assistantResult({ role: "assistant", content: "ready" }),
    ])
    const runtime = new AgentRuntime({ client })

    const result = await runtime.run({ prompt: "hello" })

    expect(result.finalMessage.content).toBe("ready")
    expect(result.toolRounds).toBe(0)
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  test("executes standard tool calls and continues the model loop", async () => {
    const events: string[] = []
    const toolCall: OpenAIChatToolCall = {
      id: "call_1",
      type: "function",
      function: {
        name: "workspace.search",
        arguments: "{\"query\":\"foo\"}",
      },
    }
    const client = fakeClient([
      assistantResult({ role: "assistant", content: null, tool_calls: [toolCall] }),
      assistantResult({ role: "assistant", content: "found foo" }),
    ])
    const runtime = new AgentRuntime({
      client,
      tools: [{
        type: "function",
        function: {
          name: "workspace.search",
          parameters: { type: "object" },
        },
      }],
      executeTool: async (call) => {
        expect(call.function.name).toBe("workspace.search")
        return { content: "foo.c:10" }
      },
    })

    const result = await runtime.run({
      prompt: "find foo",
      onEvent: (event) => events.push(event.type),
    })

    expect(result.finalMessage.content).toBe("found foo")
    expect(result.toolRounds).toBe(1)
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(result.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "foo.c:10",
    })
    expect(events).toEqual(expect.arrayContaining(["assistant-message", "tool-start", "tool-result"]))
  })

  test("stops runaway tool loops at the configured limit", async () => {
    const toolCall: OpenAIChatToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "workspace.search", arguments: "{}" },
    }
    const runtime = new AgentRuntime({
      client: fakeClient([
        assistantResult({ role: "assistant", tool_calls: [toolCall] }),
        assistantResult({ role: "assistant", tool_calls: [toolCall] }),
      ]),
      maxToolRounds: 1,
      executeTool: async () => "ok",
    })

    await expect(runtime.run({ prompt: "loop" })).rejects.toThrow("Tool round limit exceeded")
  })
})

function fakeClient(results: OpenAIChatCompletionResult[]) {
  let index = 0
  return {
    async complete() {
      const result = results[index++]
      if (!result) throw new Error("unexpected model call")
      return result
    },
  }
}

function assistantResult(message: OpenAIChatMessage): OpenAIChatCompletionResult {
  return {
    message,
    streamed: false,
  }
}
