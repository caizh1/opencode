import type {
  OpenAIChatClient,
  OpenAIChatCompletionResult,
  OpenAIChatMessage,
  OpenAIChatStreamEvent,
  OpenAIChatTool,
  OpenAIChatToolCall,
} from "./openai-chat-client"

export type AgentRuntimeEvent =
  | { type: "model-event"; event: OpenAIChatStreamEvent }
  | { type: "assistant-message"; message: OpenAIChatMessage }
  | { type: "tool-start"; call: OpenAIChatToolCall }
  | { type: "tool-result"; call: OpenAIChatToolCall; content: string; error?: string }

export type AgentToolExecution = {
  content: string
}

export type AgentToolExecutor = (call: OpenAIChatToolCall, input: {
  signal?: AbortSignal
  round: number
}) => Promise<AgentToolExecution | string | unknown>

export type AgentRuntimeResult = {
  messages: OpenAIChatMessage[]
  finalMessage: OpenAIChatMessage
  toolRounds: number
}

export class AgentRuntimeToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentRuntimeToolError"
  }
}

export class AgentRuntime {
  constructor(private readonly deps: {
    client: Pick<OpenAIChatClient, "complete">
    tools?: OpenAIChatTool[]
    executeTool?: AgentToolExecutor
    maxToolRounds?: number
  }) {}

  async run(input: {
    prompt?: string
    messages?: OpenAIChatMessage[]
    signal?: AbortSignal
    tools?: OpenAIChatTool[]
    onEvent?: (event: AgentRuntimeEvent) => void
  }): Promise<AgentRuntimeResult> {
    const messages = [...(input.messages ?? [])]
    if (input.prompt !== undefined) messages.push({ role: "user", content: input.prompt })

    const tools = input.tools ?? this.deps.tools ?? []
    const maxToolRounds = Math.max(0, this.deps.maxToolRounds ?? 4)
    let toolRounds = 0

    while (!input.signal?.aborted) {
      const result = await this.deps.client.complete({
        messages,
        tools,
        signal: input.signal,
        onEvent: (event) => input.onEvent?.({ type: "model-event", event }),
      })
      messages.push(result.message)
      input.onEvent?.({ type: "assistant-message", message: result.message })

      const calls = result.message.tool_calls ?? []
      if (calls.length === 0) {
        return {
          messages,
          finalMessage: result.message,
          toolRounds,
        }
      }

      if (toolRounds >= maxToolRounds) {
        throw new AgentRuntimeToolError(`Tool round limit exceeded (${maxToolRounds}).`)
      }
      if (!this.deps.executeTool) {
        throw new AgentRuntimeToolError("Model requested a tool call, but no tool executor is registered.")
      }

      toolRounds += 1
      for (const call of calls) {
        input.onEvent?.({ type: "tool-start", call })
        const toolMessage = await this.executeToolCall(call, toolRounds, input.signal, input.onEvent)
        messages.push(toolMessage)
      }
    }

    throw new AgentRuntimeToolError("Agent runtime was cancelled.")
  }

  private async executeToolCall(
    call: OpenAIChatToolCall,
    round: number,
    signal: AbortSignal | undefined,
    onEvent: ((event: AgentRuntimeEvent) => void) | undefined,
  ): Promise<OpenAIChatMessage> {
    try {
      const result = await this.deps.executeTool!(call, { signal, round })
      const content = normalizeToolResult(result)
      onEvent?.({ type: "tool-result", call, content })
      return {
        role: "tool",
        tool_call_id: call.id,
        content,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onEvent?.({ type: "tool-result", call, content: message, error: message })
      return {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ ok: false, error: message }),
      }
    }
  }
}

function normalizeToolResult(input: AgentToolExecution | string | unknown) {
  if (typeof input === "string") return input
  if (isAgentToolExecution(input)) return input.content
  return JSON.stringify(input)
}

function isAgentToolExecution(input: unknown): input is AgentToolExecution {
  return Boolean(input && typeof input === "object" && "content" in input && typeof (input as AgentToolExecution).content === "string")
}

export type { OpenAIChatCompletionResult, OpenAIChatMessage, OpenAIChatTool, OpenAIChatToolCall }
