import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { McpStdioRuntime, mcpToolName, readMcpManifest } from "../src/mcp-stdio-runtime"
import type { InstalledChipMatePackage } from "../src/skills-installer"

describe("MCP stdio runtime", () => {
  test("lists stdio MCP tools and calls them through registry entries", async () => {
    const pkg = await fakeMcpPackage("demo")
    const runtime = new McpStdioRuntime({
      packages: [pkg],
      permissionProfile: "fullAccess",
      workspaceRoots: [pkg.root],
    })

    const entries = await runtime.registryEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.definition.function.name).toBe("mcp_demo_echo")
    expect(entries[0]!.definition.function.parameters).toMatchObject({
      type: "object",
      required: ["text"],
    })

    const result = await entries[0]!.execute({
      id: "call-1",
      type: "function",
      function: {
        name: mcpToolName("demo", "echo"),
        arguments: JSON.stringify({ text: "hello" }),
      },
    }, { round: 1 })

    expect(result).toMatchObject({
      ok: true,
      packageId: "demo",
      tool: "echo",
      result: {
        content: [{ type: "text", text: "echo: hello" }],
      },
    })
  })

  test("applies ChipMate permissions before running MCP tools", async () => {
    const pkg = await fakeMcpPackage("locked")
    const runtime = new McpStdioRuntime({
      packages: [pkg],
      permissionProfile: "readOnly",
      workspaceRoots: [pkg.root],
    })
    const [entry] = await runtime.registryEntries()

    const result = await entry!.execute({
      id: "call-1",
      type: "function",
      function: {
        name: mcpToolName("locked", "echo"),
        arguments: JSON.stringify({ text: "hello" }),
      },
    }, { round: 1 })

    expect(result).toMatchObject({
      ok: false,
      packageId: "locked",
      tool: "echo",
      permission: {
        status: "deny",
      },
    })
  })

  test("runs MCP tools after request-approval callback allows them", async () => {
    const pkg = await fakeMcpPackage("prompted")
    const runtime = new McpStdioRuntime({
      packages: [pkg],
      permissionProfile: "askApproval",
      workspaceRoots: [pkg.root],
      requestApproval: (_permission, context) => context.packageId === "prompted" && context.toolName === "echo" ? "allowOnce" : "deny",
    })
    const [entry] = await runtime.registryEntries()

    const result = await entry!.execute({
      id: "call-1",
      type: "function",
      function: {
        name: mcpToolName("prompted", "echo"),
        arguments: JSON.stringify({ text: "approved" }),
      },
    }, { round: 1 })

    expect(result).toMatchObject({
      ok: true,
      packageId: "prompted",
      tool: "echo",
      permission: {
        status: "allow",
      },
      result: {
        content: [{ type: "text", text: "echo: approved" }],
      },
    })
  })

  test("reads stdio MCP package manifests", async () => {
    const pkg = await fakeMcpPackage("manifest")
    await expect(readMcpManifest(pkg.root)).resolves.toMatchObject({
      transport: "stdio",
      command: process.execPath,
    })
  })
})

async function fakeMcpPackage(id: string): Promise<InstalledChipMatePackage> {
  const root = await mkdtemp(join(tmpdir(), `chipmate-mcp-${id}-`))
  const serverPath = join(root, "server.js")
  await writeFile(serverPath, fakeMcpServerSource())
  await writeFile(join(root, "mcp.json"), `${JSON.stringify({
    name: id,
    transport: "stdio",
    command: process.execPath,
    args: [serverPath],
  }, null, 2)}\n`)
  return {
    schemaVersion: 1,
    id,
    type: "mcp",
    name: id,
    version: "0.1.0",
    description: "fake mcp package",
    installedAt: new Date(0).toISOString(),
    sourceCatalogUrl: "http://catalog.local/catalog.json",
    root,
  }
}

function fakeMcpServerSource() {
  return `
let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])
  while (true) {
    const separator = buffer.indexOf("\\r\\n\\r\\n")
    if (separator === -1) return
    const header = buffer.subarray(0, separator).toString("utf8")
    const match = /content-length:\\s*(\\d+)/i.exec(header)
    if (!match) return
    const length = Number(match[1])
    const start = separator + 4
    const end = start + length
    if (buffer.byteLength < end) return
    const message = JSON.parse(buffer.subarray(start, end).toString("utf8"))
    buffer = buffer.subarray(end)
    handle(message)
  }
})
function write(message) {
  const body = JSON.stringify(message)
  process.stdout.write("Content-Length: " + Buffer.byteLength(body, "utf8") + "\\r\\n\\r\\n" + body)
}
function handle(message) {
  if (!message.id) return
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } })
    return
  }
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } })
    return
  }
  if (message.method === "tools/call") {
    write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo: " + (message.params?.arguments?.text || "") }] } })
    return
  }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })
}
`
}
