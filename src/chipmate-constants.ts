export const CHIPMATE_CONFIG_SECTION = "chipmate"
export const CHIPMATE_DISPLAY_NAME = "ChipMate"
export const CHIPMATE_VIEW_CONTAINER_ID = "chipmate"
export const CHIPMATE_CHAT_VIEW_ID = "chipmate.sidebar"
export const CHIPMATE_OUTPUT_CHANNEL = "ChipMate"
export const CHIPMATE_SESSION_TITLE = "ChipMate chat"
export const CHIPMATE_LOCAL_AGENT_ID = "chipmate-local"

export const PROVIDER_API_KEY_SECRET_KEY = "chipmate.provider.apiKey"
export const RAG_API_KEY_SECRET_KEY = "chipmate.rag.apiKey"

export const CHIPMATE_COMMANDS = {
  openChat: "chipmate.openChat",
  newSession: "chipmate.newSession",
  askSelection: "chipmate.askSelection",
  askCurrentFile: "chipmate.askCurrentFile",
  addFileToContext: "chipmate.addFileToContext",
  clearContext: "chipmate.clearContext",
  openOutput: "chipmate.openOutput",
  setProviderApiKey: "chipmate.provider.setApiKey",
  refreshModels: "chipmate.provider.refreshModels",
  completionCommitInlineSuggestion: "chipmate.completion.commitInlineSuggestion",
  completionRunDirectAblation: "chipmate.completion.runDirectAblation",
  codeGraphIndex: "chipmate.codeGraph.index",
  codeGraphRebuild: "chipmate.codeGraph.rebuild",
  codeGraphPause: "chipmate.codeGraph.pause",
  codeGraphResume: "chipmate.codeGraph.resume",
  codeGraphCancel: "chipmate.codeGraph.cancel",
  codeGraphBenchmark: "chipmate.codeGraph.benchmark",
  codeGraphStatus: "chipmate.codeGraph.status",
} as const
