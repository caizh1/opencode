import { DEFAULT_ANALYSIS_TOOL_POLICY } from "./codegraph-analysis"
import type { AnalysisToolName } from "./analysis-types"

export type LocalAnalysisToolTemplateInput = {
  endpoint: string
  token: string
}

const TOOL_NAMES: AnalysisToolName[] = [
  "search",
  "getFileSlice",
  "getSymbol",
  "getCallers",
  "getCallees",
  "getCallChain",
  "getModuleMap",
  "getStateMachines",
  "getStatePath",
  "queryEvidence",
]

export function createOpenCodeLocalAnalysisTool(input: LocalAnalysisToolTemplateInput) {
  return `import { tool } from "@opencode-ai/plugin"

const ENDPOINT = ${JSON.stringify(input.endpoint)}
const TOKEN = ${JSON.stringify(input.token)}

export default tool({
  description: "opencode_local_analysis: query VS Code's local code intelligence index. Use this instead of remote read/grep/web tools for local workspace questions.",
  args: {
    tool: tool.schema.enum(${JSON.stringify(TOOL_NAMES)}).describe("Local analysis operation to run."),
    query: tool.schema.string().optional().describe("Search or evidence question."),
    question: tool.schema.string().optional().describe("Full natural-language local code question."),
    path: tool.schema.string().optional().describe("Workspace-relative file path."),
    name: tool.schema.string().optional().describe("Symbol name."),
    symbol: tool.schema.string().optional().describe("Source symbol for caller/callee/call-chain queries."),
    target: tool.schema.string().optional().describe("Target symbol for call-chain queries."),
    machineId: tool.schema.string().optional().describe("State machine id."),
    source: tool.schema.string().optional().describe("Source state for state path queries."),
    startLine: tool.schema.number().optional().describe("1-based start line for file slices."),
    endLine: tool.schema.number().optional().describe("1-based end line for file slices."),
    maxDepth: tool.schema.number().optional().describe("Maximum graph depth."),
    maxFanout: tool.schema.number().optional().describe("Maximum graph fanout."),
  },
  async execute(args) {
    const response = await fetch(ENDPOINT + "/tool", {
      method: "POST",
      headers: {
        authorization: "Bearer " + TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tool: args.tool, args }),
    })
    const text = await response.text()
    if (!response.ok) {
      return { title: "Local analysis blocked", output: text || String(response.status) }
    }
    return { title: "Local analysis: " + args.tool, output: text }
  },
})
`
}

export function createOpenCodeLocalAgentPolicyTemplate() {
  return JSON.stringify(
    {
      agent: {
        "vscode-local": {
          description: "Use VS Code supplied local evidence and the opencode_local_analysis custom tool. Do not use public web tools or remote filesystem tools for local workspace questions.",
          permission: {
            webfetch: "deny",
            websearch: "deny",
            edit: DEFAULT_ANALYSIS_TOOL_POLICY.edit,
            bash: DEFAULT_ANALYSIS_TOOL_POLICY.bash,
            read: DEFAULT_ANALYSIS_TOOL_POLICY.read,
            grep: "deny",
            glob: "deny",
            list: "deny",
            opencode_local_analysis: "allow",
          },
        },
      },
    },
    null,
    2,
  )
}

export function localAnalysisToolNames() {
  return [...TOOL_NAMES]
}
