import { agentListSummary, findAgentByName } from "./agent-name"
import type { ChipMateAgentInfo, RemoteSettings } from "./types"

export const DEFAULT_LOCAL_ONLY_AGENT = "chipmate-local"

type AgentListClient = {
  listAgents(signal?: AbortSignal): Promise<ChipMateAgentInfo[]>
}

export type RequestAgentSelection = {
  agent?: string
  label: string
  strict: boolean
  ready: boolean
  warning?: string
}

export class MissingLocalOnlyAgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MissingLocalOnlyAgentError"
  }
}

export function localOnlyAgentName(settings: Pick<RemoteSettings, "localOnlyAgent">) {
  return settings.localOnlyAgent.trim() || DEFAULT_LOCAL_ONLY_AGENT
}

export function selectRequestAgent(input: {
  settings: RemoteSettings
  agents?: ChipMateAgentInfo[]
  agentError?: string
}): RequestAgentSelection {
  const settings = input.settings
  if (settings.context.localOnlyMode) {
    const agent = localOnlyAgentName(settings)
    const label = `VS Code local agent: ${agent}`
    if (input.agentError) {
      return {
        agent,
        label,
        strict: true,
        ready: false,
        warning: `Cannot verify required VS Code local agent "${agent}": ${input.agentError}`,
      }
    }
    if (!input.agents) {
      return {
        agent,
        label,
        strict: true,
        ready: false,
        warning: `Required ChipMate workspace agent "${agent}" has not been loaded yet.`,
      }
    }
    const match = findAgentByName(input.agents, agent)
    if (!match) {
      return {
        agent,
        label,
        strict: true,
        ready: false,
        warning: `Required ChipMate workspace agent "${agent}" was not found. Available agents: ${agentListSummary(input.agents)}.`,
      }
    }
    if (match.disabled) {
      return {
        agent,
        label,
        strict: true,
        ready: false,
        warning: `Required ChipMate workspace agent "${agent}" is disabled.`,
      }
    }
    return {
      agent,
      label,
      strict: true,
      ready: true,
    }
  }

  const defaultAgent = settings.defaultAgent.trim()
  if (defaultAgent) {
    return {
      agent: defaultAgent,
      strict: false,
      ready: true,
      label: `default agent: ${defaultAgent}`,
    }
  }
  return {
    agent: undefined,
    strict: false,
    ready: true,
    label: "no agent override",
  }
}

export function requireRequestAgent(input: {
  settings: RemoteSettings
  agents?: ChipMateAgentInfo[]
  agentError?: string
}) {
  const selection = selectRequestAgent(input)
  if (!selection.ready) {
    throw new MissingLocalOnlyAgentError(selection.warning ?? "Required VS Code local agent is not available.")
  }
  return selection
}

export async function resolveRequestAgent(
  client: AgentListClient,
  settings: RemoteSettings,
  signal?: AbortSignal,
) {
  if (!settings.context.localOnlyMode) return requireRequestAgent({ settings })
  try {
    const agents = await client.listAgents(signal)
    return requireRequestAgent({ settings, agents })
  } catch (error) {
    if (error instanceof MissingLocalOnlyAgentError) throw error
    throw new MissingLocalOnlyAgentError(
      `Cannot verify required VS Code local agent "${localOnlyAgentName(settings)}": ${formatError(error)}`,
    )
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
