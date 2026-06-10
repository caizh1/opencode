import type { AgentToolExecutor } from "./agent-runtime"
import type { OpenAIChatTool, OpenAIChatToolCall } from "./openai-chat-client"

export type ToolRegistryEntry = {
  name: string
  aliases?: string[]
  definition: OpenAIChatTool
  execute: AgentToolExecutor
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolRegistryError"
  }
}

export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>()

  constructor(entries: ToolRegistryEntry[] = []) {
    for (const entry of entries) this.register(entry)
  }

  register(entry: ToolRegistryEntry) {
    const keys = [entry.name, entry.definition.function.name, ...(entry.aliases ?? [])].map(normalizeToolName)
    for (const key of keys) {
      const existing = this.entries.get(key)
      if (existing && existing !== entry) throw new ToolRegistryError(`Duplicate tool registration: ${key}`)
      this.entries.set(key, entry)
    }
  }

  toolDefinitions(): OpenAIChatTool[] {
    const seen = new Set<ToolRegistryEntry>()
    const result: OpenAIChatTool[] = []
    for (const entry of this.entries.values()) {
      if (seen.has(entry)) continue
      seen.add(entry)
      result.push(entry.definition)
    }
    return result
  }

  executor(): AgentToolExecutor {
    return async (call, input) => this.execute(call, input)
  }

  async execute(call: OpenAIChatToolCall, input: Parameters<AgentToolExecutor>[1]) {
    const entry = this.entries.get(normalizeToolName(call.function.name))
    if (!entry) throw new ToolRegistryError(`Unknown tool: ${call.function.name}`)
    return entry.execute(call, input)
  }
}

export function normalizeToolName(input: string) {
  return input.trim().replace(/\./g, "_")
}

export function toolAliasNames(name: string) {
  const normalized = normalizeToolName(name)
  const dotted = normalized.replace(/_/g, ".")
  return normalized === dotted ? [normalized] : [normalized, dotted]
}
