import * as http from "node:http"
import { randomBytes } from "node:crypto"
import * as vscode from "vscode"
import { createOpenCodeLocalAgentPolicyTemplate, createOpenCodeLocalAnalysisTool } from "./analysis-tool-template"
import type { AnalysisToolName, AnalysisToolResult } from "./analysis-types"

export type AnalysisBridgeRunner = (input: {
  tool: AnalysisToolName
  args?: Record<string, unknown>
}) => Promise<AnalysisToolResult>

export type AnalysisBridgeStatus = {
  enabled: boolean
  running: boolean
  endpoint?: string
  toolPath?: string
  policyPath?: string
  lastError?: string
}

export class LocalAnalysisBridge implements vscode.Disposable {
  private server?: http.Server
  private endpointValue = ""
  private token = ""
  private toolPathValue = ""
  private policyPathValue = ""
  private lastErrorValue = ""

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly runner: AnalysisBridgeRunner,
    private readonly enabled: () => boolean,
  ) {}

  dispose() {
    this.stop()
  }

  status(): AnalysisBridgeStatus {
    return {
      enabled: this.enabled(),
      running: Boolean(this.server && this.endpointValue),
      endpoint: this.endpointValue || undefined,
      toolPath: this.toolPathValue || undefined,
      policyPath: this.policyPathValue || undefined,
      lastError: this.lastErrorValue || undefined,
    }
  }

  async ensureStarted() {
    if (!this.enabled()) {
      this.stop()
      return this.status()
    }
    if (!this.server) await this.startServer()
    await this.writeOpenCodeTool()
    return this.status()
  }

  stop() {
    this.server?.close()
    this.server = undefined
    this.endpointValue = ""
  }

  private async startServer() {
    this.token = randomBytes(24).toString("hex")
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject)
      this.server?.listen(0, "127.0.0.1", () => resolve())
    })
    const address = this.server.address()
    if (!address || typeof address === "string") throw new Error("Local analysis bridge did not bind a TCP port.")
    this.endpointValue = `http://127.0.0.1:${address.port}`
    this.output.appendLine(`[analysis-bridge] listening on ${this.endpointValue}`)
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const started = Date.now()
    try {
      if (!this.authorized(request)) {
        writeJson(response, 401, { ok: false, error: "Unauthorized local analysis request." })
        return
      }
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, { ok: true, endpoint: this.endpointValue })
        return
      }
      if (request.method !== "POST" || request.url !== "/tool") {
        writeJson(response, 404, { ok: false, error: "Unknown local analysis bridge route." })
        return
      }
      const body = await readBody(request, 512 * 1024)
      const payload = parsePayload(body)
      const result = await this.runner(payload)
      writeJson(response, result.ok ? 200 : 400, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastErrorValue = message
      this.output.appendLine(`[analysis-bridge] request failed after ${Date.now() - started}ms: ${message}`)
      writeJson(response, 500, { ok: false, error: message })
    }
  }

  private authorized(request: http.IncomingMessage) {
    const header = request.headers.authorization ?? ""
    return header === `Bearer ${this.token}`
  }

  private async writeOpenCodeTool() {
    const root = vscode.workspace.workspaceFolders?.[0]
    if (!root || !this.endpointValue || !this.token) return
    const opencodeDir = vscode.Uri.joinPath(root.uri, ".opencode")
    const toolsDir = vscode.Uri.joinPath(opencodeDir, "tools")
    await vscode.workspace.fs.createDirectory(toolsDir)
    const toolUri = vscode.Uri.joinPath(toolsDir, "opencode_local_analysis.ts")
    const policyUri = vscode.Uri.joinPath(opencodeDir, "vscode-local-agent-policy.template.json")
    await vscode.workspace.fs.writeFile(toolUri, encode(createOpenCodeLocalAnalysisTool({ endpoint: this.endpointValue, token: this.token })))
    await vscode.workspace.fs.writeFile(policyUri, encode(createOpenCodeLocalAgentPolicyTemplate()))
    this.toolPathValue = vscode.workspace.asRelativePath(toolUri, false)
    this.policyPathValue = vscode.workspace.asRelativePath(policyUri, false)
    this.output.appendLine(`[analysis-bridge] wrote ${this.toolPathValue} and ${this.policyPathValue}`)
  }
}

function parsePayload(body: string) {
  const parsed = JSON.parse(body) as { tool?: unknown; args?: unknown }
  if (typeof parsed.tool !== "string") throw new Error("tool is required.")
  if (!isAnalysisToolName(parsed.tool)) throw new Error(`Unknown analysis tool: ${parsed.tool}`)
  return {
    tool: parsed.tool,
    args: objectArgs(parsed.args),
  }
}

function isAnalysisToolName(value: string): value is AnalysisToolName {
  return [
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
  ].includes(value)
}

function objectArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function readBody(request: http.IncomingMessage, maxBytes: number) {
  return new Promise<string>((resolve, reject) => {
    let body = ""
    let bytes = 0
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8")
      if (bytes > maxBytes) {
        reject(new Error("Local analysis request body is too large."))
        request.destroy()
        return
      }
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}

function writeJson(response: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value, null, 2)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(body)
}

function encode(value: string) {
  return new TextEncoder().encode(value)
}
