import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "../src/agent-runtime"
import type { OpenAIChatCompletionResult, OpenAIChatMessage, OpenAIChatTool, OpenAIChatToolCall } from "../src/openai-chat-client"
import { normalizeToolName, ToolRegistry, ToolRegistryError, toolAliasNames } from "../src/tool-registry"

describe("ToolRegistry", () => {
  test("normalizes dotted OpenAI tool names to underscore-safe names", () => {
    expect(normalizeToolName(" workspace.search ")).toBe("workspace_search")
    expect(toolAliasNames("workspace_search")).toEqual(["workspace_search", "workspace.search"])
  })

  test("returns unique tool definitions while dispatching dotted aliases", async () => {
    const calls: string[] = []
    const registry = new ToolRegistry([{
      name: "workspace_search",
      aliases: ["workspace.search"],
      definition: toolDefinition("workspace_search"),
      execute: async (call, input) => {
        calls.push(`${call.function.name}:${input.round}`)
        return { content: "found" }
      },
    }])

    expect(registry.toolDefinitions().map((tool) => tool.function.name)).toEqual(["workspace_search"])
    await expect(registry.execute(toolCall("workspace.search", "{\"query\":\"foo\"}"), { round: 2 })).resolves.toEqual({ content: "found" })
    expect(calls).toEqual(["workspace.search:2"])
  })

  test("rejects duplicate registrations for the same normalized name", () => {
    const registry = new ToolRegistry([{
      name: "workspace_search",
      definition: toolDefinition("workspace_search"),
      execute: async () => "first",
    }])

    expect(() => registry.register({
      name: "workspace.search",
      definition: toolDefinition("workspace_search"),
      execute: async () => "second",
    })).toThrow(ToolRegistryError)
  })

  test("plugs into AgentRuntime standard tool-call loop", async () => {
    const call = toolCall("math.add", "{\"left\":1,\"right\":2}")
    const requestedTools: string[][] = []
    const registry = new ToolRegistry([{
      name: "math_add",
      aliases: ["math.add"],
      definition: toolDefinition("math_add"),
      execute: async () => ({ sum: 3 }),
    }])
    const runtime = new AgentRuntime({
      client: fakeClient([
        assistantResult({ role: "assistant", content: null, tool_calls: [call] }),
        assistantResult({ role: "assistant", content: "done" }),
      ], requestedTools),
      tools: registry.toolDefinitions(),
      executeTool: registry.executor(),
    })

    const result = await runtime.run({ prompt: "add" })

    expect(requestedTools[0]).toEqual(["math_add"])
    expect(result.toolRounds).toBe(1)
    expect(result.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "{\"sum\":3}",
    })
    expect(result.finalMessage.content).toBe("done")
  })
})

function toolDefinition(name: string): OpenAIChatTool {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object" },
    },
  }
}

function toolCall(name: string, args: string): OpenAIChatToolCall {
  return {
    id: "call_1",
    type: "function",
    function: {
      name,
      arguments: args,
    },
  }
}

function fakeClient(results: OpenAIChatCompletionResult[], requestedTools: string[][]) {
  let index = 0
  return {
    async complete(input: { tools?: OpenAIChatTool[] }) {
      requestedTools.push(input.tools?.map((tool) => tool.function.name) ?? [])
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
