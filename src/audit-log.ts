import * as vscode from "vscode"

export type AuditEvent = {
  id: string
  at: number
  sessionID?: string
  kind: string
  title: string
  approved: boolean
  risk?: string
  reason?: string
  detail?: unknown
}

export class AuditLog {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async append(event: AuditEvent) {
    const root = vscode.Uri.joinPath(this.context.globalStorageUri, "audit")
    await vscode.workspace.fs.createDirectory(root)
    const date = new Date(event.at).toISOString().slice(0, 10)
    const uri = vscode.Uri.joinPath(root, `${date}.jsonl`)
    const previous = await readText(uri)
    const next = `${previous}${JSON.stringify(event)}\n`
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next))
  }
}

async function readText(uri: vscode.Uri) {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
  } catch {
    return ""
  }
}
