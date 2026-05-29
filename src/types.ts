export type ConnectionState = "disconnected" | "connecting" | "connected" | "authFailed" | "error"
export type CompletionLogLevel = "off" | "info" | "debug"

export type RemoteSettings = {
  serverUrl: string
  username: string
  defaultModel: string
  defaultAgent: string
  localOnlyAgent: string
  context: {
    maxFileBytes: number
    maxFiles: number
    includeDiagnostics: boolean
    includeGitDiff: boolean
    localOnlyMode: boolean
    strictLocalOnlyAgent: boolean
  }
  completion: {
    enabled: boolean
    debounceMs: number
    logLevel: CompletionLogLevel
  }
}

export type HealthResponse = {
  healthy: boolean
  version?: string
}

export type OpenCodeSession = {
  id: string
  title?: string
  directory?: string
  time?: {
    created?: number
    updated?: number
  }
}

export type OpenCodeMessageInfo = {
  id: string
  sessionID?: string
  role?: "user" | "assistant"
  time?: {
    created?: number
    completed?: number
  }
  error?: {
    name?: string
    message?: string
  }
}

export type OpenCodePart =
  | {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
    }
  | {
      type: "reasoning"
      text: string
    }
  | {
      type: "file"
      filename?: string
      url?: string
      mime?: string
    }
  | {
      type: "tool"
      tool?: string
      callID?: string
      state?: {
        status?: string
        input?: unknown
        output?: unknown
        error?: unknown
        metadata?: unknown
      }
    }
  | {
      type: string
      [key: string]: unknown
    }

export type OpenCodeMessage = {
  info: OpenCodeMessageInfo
  parts: OpenCodePart[]
}

export type ChatContextOptions = {
  includeSelection: boolean
  includeCurrentFile: boolean
  includeOpenFiles: boolean
  includeDiagnostics: boolean
  includeGitDiff: boolean
}

export type PromptModel = {
  providerID: string
  modelID: string
}

export type OpenCodeModelInfo = {
  id: string
  providerID: string
  modelID: string
  name: string
  providerName: string
  isDefault: boolean
}
