import * as path from "node:path"
import * as vscode from "vscode"

export type StoredDocxFile = {
  path: string
  absolutePath: string
}

export class DocxFileStore {
  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async write(input: { filename: string; bytes: Uint8Array }): Promise<StoredDocxFile> {
    const outputDir = path.join(this.workspaceRoot, ".chipmate", "docs")
    const safeName = sanitizeDocxFilename(input.filename)
    const target = path.join(outputDir, safeName)
    assertWithinDocs(outputDir, target)
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir))
    if (await exists(target)) throw new Error(`Refusing to overwrite existing DOCX: ${target}`)
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), input.bytes)
    return {
      path: path.posix.join(".chipmate", "docs", safeName),
      absolutePath: target,
    }
  }
}

export function sanitizeDocxFilename(input: string) {
  const base = input
    .replace(/\.docx$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "generated-guideline"
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
  return `${base}-${stamp}.docx`
}

function assertWithinDocs(outputDir: string, target: string) {
  const root = normalize(outputDir)
  const candidate = normalize(target)
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Generated DOCX path escapes .chipmate/docs: ${target}`)
  }
}

async function exists(target: string) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target))
    return true
  } catch {
    return false
  }
}

function normalize(input: string) {
  return path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "")
}
