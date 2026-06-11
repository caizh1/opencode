import type { ChipMateAgentInfo } from "./types"

export function canonicalAgentName(value: string | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function agentMatchesName(agent: Pick<ChipMateAgentInfo, "id" | "name">, required: string) {
  if (agent.id === required) return true
  const target = canonicalAgentName(required)
  return canonicalAgentName(agent.id) === target || canonicalAgentName(agent.name) === target
}

export function findAgentByName(agents: ChipMateAgentInfo[], required: string) {
  return agents.find((candidate) => candidate.id === required) ?? agents.find((candidate) => agentMatchesName(candidate, required))
}

export function agentListSummary(agents: ChipMateAgentInfo[]) {
  if (agents.length === 0) return "none"
  return agents.map(agentLabel).join(", ")
}

function agentLabel(agent: ChipMateAgentInfo) {
  if (agent.name && agent.name !== agent.id) return `${agent.id} (${agent.name})`
  return agent.id || agent.name
}
