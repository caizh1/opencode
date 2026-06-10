import type { ContextSummaryItem } from "../context"
import type { McpToolInfo } from "../mcp-stdio-runtime"
import type { ChipMatePermissionProfile } from "../permissions"
import type { ChipMateCatalogPackage } from "../skills-catalog"
import type { InstalledChipMatePackage } from "../skills-installer"
import type { CodeGraphStatus, RagSettings, RagStatus, RemoteSettings } from "../types"

export type ChipMateViewModule = "chat" | "models" | "knowledge" | "skills" | "mcp" | "settings"

export type ChipMateRenderedMessage = {
  id: string
  role: string
  text: string
  createdAt: number
}

export type ChipMateRenderedSession = {
  id: string
  title: string
  updatedAt: number
}

export type MentionedFileRef = {
  uri: string
  label?: string
}

export type MentionIndexState = {
  entries: import("../mention-index").MentionIndexEntry[]
  truncated: boolean
}

export type ChipMateSkillCapabilitySummary = {
  id: string
  name: string
  description: string
  version?: string
  root: string
  allowedTools: string[]
  compatibility: string[]
  state: "Ready" | "Missing SKILL.md" | "Script approval needed" | "Invalid package"
  error?: string
}

export type ChipMateMcpProbeTool = McpToolInfo & {
  exposedName: string
  schemaSummary: string
  availability: "Ready" | "Needs approval" | "Blocked" | "Probe failed"
}

export type ChipMateMcpProbeResult = {
  packageId: string
  state: "unprobed" | "probing" | "ready" | "error"
  manifestValid: boolean
  tools: ChipMateMcpProbeTool[]
  error?: string
  probedAt?: number
}

export type ChipMateKnowledgeAction = "check" | "apply" | "rebuild" | "pause" | "resume" | "cancel"

export type ChipMateViewMessage =
  | { type: "ready" }
  | { type: "newSession" }
  | { type: "selectSession"; sessionId: string }
  | { type: "sendMessage"; text: string; mentionedFiles?: MentionedFileRef[] }
  | { type: "cancelSend" }
  | { type: "searchFilesForMention"; query?: string; requestId?: number }
  | { type: "refreshCatalog" }
  | { type: "installPackage"; id: string; packageType: "skill" | "mcp"; version: string }
  | { type: "rollbackPackage"; id: string; packageType: "skill" | "mcp" }
  | { type: "probeMcpPackage"; id?: string }
  | { type: "knowledgeAction"; action: ChipMateKnowledgeAction }
  | {
    type: "saveSettings"
    apiBaseUrl: string
    model: string
    catalogUrl: string
    permissionProfile: ChipMatePermissionProfile
  }
  | {
    type: "saveModelSettings"
    chatApiBaseUrl: string
    chatModel: string
    chatStreaming: boolean
    chatMaxTokens: number
    chatTemperature: number
    chatTopP: number
    completionEnabled: boolean
    completionApiBaseUrl: string
    completionModel: string
    completionProfile: RemoteSettings["completion"]["profile"]
    completionDebounceMs: number
    completionMaxTokens: number
    completionTemperature: number
    completionTopP: number
    completionLogLevel: RemoteSettings["completion"]["logLevel"]
  }
  | {
    type: "saveKnowledgeSettings"
    rag: {
      embeddingEndpoint: string
      embeddingModel: string
      embeddingBatchSize: number
      embeddingMaxTokensPerRequest: number
      embeddingConcurrentRequests: number
      embeddingMaxInFlightTokens: number
      embeddingEncodingFormat: RagSettings["embedding"]["encodingFormat"]
      embeddingCheckpointMode: RagSettings["embedding"]["checkpointMode"]
      embeddingCheckpointChunkInterval: number
      embeddingCheckpointIntervalMs: number
      embeddingRequestDelayMs: number
      embeddingMaxRequestsPerRun: number
      embeddingMaxRetries: number
      embeddingRetryBackoffMs: number
      embeddingResumeAutomatically: boolean
      embeddingResumeDelayMs: number
      rerankEndpoint: string
      rerankModel: string
      allowedHosts: string[]
      vectorTopK: number
      rerankTopK: number
    }
  }
  | {
    type: "saveGlobalSettings"
    catalogUrl: string
    permissionProfile: ChipMatePermissionProfile
  }
  | { type: "setApiKey" }
  | { type: "setRagApiKey" }
  | { type: "addFile" }
  | { type: "clearContext" }
  | { type: "openOutput" }

export type ChipMateViewState = {
  apiBaseUrl: string
  model: string
  configured: boolean
  permissionProfile: ChipMatePermissionProfile
  catalogUrl: string
  catalogPackages: ChipMateCatalogPackage[]
  installedPackages: InstalledChipMatePackage[]
  skillSummaries: ChipMateSkillCapabilitySummary[]
  mcpProbeResults: Record<string, ChipMateMcpProbeResult>
  sessions: ChipMateRenderedSession[]
  activeSessionId?: string
  messages: ChipMateRenderedMessage[]
  contextLabels: string[]
  contextSummary: ContextSummaryItem[]
  sending: boolean
  streamingText: string
  toolStatus: string
  error: string
  catalogError: string
  knowledgeNotice: string
  settingsNotice: string
  chatSettings: RemoteSettings["chat"]
  completionSettings: RemoteSettings["completion"]
  ragSettings: RemoteSettings["rag"]
  codeGraphSettings: RemoteSettings["codeGraph"]
  contextSettings: RemoteSettings["context"]
  codeGraphStatus?: CodeGraphStatus
  ragStatus?: RagStatus
}
