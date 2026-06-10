import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceTools } from "../src/workspace-tools"

describe("WorkspaceTools", () => {
  test("searches workspace text files and returns stable relative paths", async () => {
    await withWorkspace(async (root) => {
      await fs.mkdir(join(root, "src"), { recursive: true })
      await fs.writeFile(join(root, "src", "main.ts"), "alpha\nneedle here\n")
      const tools = new WorkspaceTools({ workspaceRoots: [root] })

      const result = await tools.search({ query: "needle", maxResults: 1 })

      expect(result.ok).toBe(true)
      expect(result.results).toEqual([{
        path: "src/main.ts",
        line: 2,
        preview: "needle here",
      }])
      expect(result.truncated).toBe(true)
    })
  })

  test("reads files with a byte cap", async () => {
    await withWorkspace(async (root) => {
      await fs.writeFile(join(root, "note.txt"), "abcdef")
      const tools = new WorkspaceTools({ workspaceRoots: [root], maxReadBytes: 3 })

      const result = await tools.readFile({ path: "note.txt" })

      expect(result).toMatchObject({
        ok: true,
        path: "note.txt",
        content: "abc",
        truncated: true,
      })
    })
  })

  test("requires approval before workspace writes in ask-approval profile", async () => {
    await withWorkspace(async (root) => {
      const tools = new WorkspaceTools({ workspaceRoots: [root], permissionProfile: "askApproval" })

      const result = await tools.writeFile({ path: "generated.txt", content: "pending" })

      expect(result.ok).toBe(false)
      expect(result.permission).toMatchObject({ status: "ask" })
      await expect(fs.readFile(join(root, "generated.txt"), "utf8")).rejects.toThrow()
    })
  })

  test("writes files under full access", async () => {
    await withWorkspace(async (root) => {
      const tools = new WorkspaceTools({ workspaceRoots: [root], permissionProfile: "fullAccess" })

      const result = await tools.writeFile({ path: "generated/out.txt", content: "ok" })

      expect(result).toMatchObject({
        ok: true,
        path: "generated/out.txt",
        bytes: 2,
      })
      await expect(fs.readFile(join(root, "generated", "out.txt"), "utf8")).resolves.toBe("ok")
    })
  })

  test("runs approved workspace writes through request-approval callback", async () => {
    await withWorkspace(async (root) => {
      const approvals: string[] = []
      const tools = new WorkspaceTools({
        workspaceRoots: [root],
        permissionProfile: "askApproval",
        requestApproval: async (_permission, context) => {
          approvals.push(`${context.capability}:${context.key}`)
          return "allowOnce"
        },
      })

      const result = await tools.writeFile({ path: "approved.txt", content: "ok" })

      expect(result).toMatchObject({
        ok: true,
        path: "approved.txt",
        permission: { status: "allow" },
      })
      expect(approvals).toEqual(["writeWorkspace:approved.txt"])
      await expect(fs.readFile(join(root, "approved.txt"), "utf8")).resolves.toBe("ok")
    })
  })

  test("blocks paths that escape the workspace", async () => {
    await withWorkspace(async (root) => {
      const tools = new WorkspaceTools({ workspaceRoots: [root], permissionProfile: "fullAccess" })

      await expect(tools.readFile({ path: "../outside.txt" })).rejects.toThrow("escapes")
      await expect(tools.writeFile({ path: "../outside.txt", content: "nope" })).rejects.toThrow("escapes")
    })
  })

  test("requires approval before shell commands and runs approved commands", async () => {
    await withWorkspace(async (root) => {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('chipmate')")}`
      const askTools = new WorkspaceTools({ workspaceRoots: [root], permissionProfile: "askApproval" })
      const fullTools = new WorkspaceTools({ workspaceRoots: [root], permissionProfile: "fullAccess" })

      const askResult = await askTools.runShell({ command })
      const fullResult = await fullTools.runShell({ command })

      expect(askResult.ok).toBe(false)
      expect(askResult.permission).toMatchObject({ status: "ask" })
      expect(fullResult).toMatchObject({
        ok: true,
        stdout: "chipmate",
        exitCode: 0,
      })
    })
  })

  test("runs approved shell commands through request-approval callback", async () => {
    await withWorkspace(async (root) => {
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('approved')")}`
      const tools = new WorkspaceTools({
        workspaceRoots: [root],
        permissionProfile: "askApproval",
        requestApproval: (_permission, context) => context.command === command ? "allowOnce" : "deny",
      })

      const result = await tools.runShell({ command })

      expect(result).toMatchObject({
        ok: true,
        stdout: "approved",
        permission: { status: "allow" },
      })
    })
  })

  test("exposes registry entries with dotted aliases", async () => {
    await withWorkspace(async (root) => {
      await fs.writeFile(join(root, "main.txt"), "needle\n")
      const tools = new WorkspaceTools({ workspaceRoots: [root] })
      const search = tools.registryEntries().find((entry) => entry.name === "workspace_search")

      const result = await search!.execute({
        id: "call_1",
        type: "function",
        function: {
          name: "workspace.search",
          arguments: "{\"query\":\"needle\"}",
        },
      }, { round: 1 })

      expect(result).toMatchObject({
        ok: true,
        results: [{ path: "main.txt", line: 1, preview: "needle" }],
      })
    })
  })
})

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), "chipmate-workspace-tools-"))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
