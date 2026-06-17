import * as vscode from "vscode"

type Pos = { line: number; character: number }
type Range = { start: Pos; end: Pos }

export type QwenDefinition = {
  filepath: string
  range: Range
}

// qwen/Kilo adapter for Continue IDE.gotoDefinition and readRangeInFile.
// It normalizes VS Code Location and LocationLink outputs before any caller
// reads target content.
export async function lookupQwenDefinitions(
  filepath: string,
  position: Pos,
  timeout: number,
): Promise<QwenDefinition[]> {
  const uri = vscode.Uri.file(filepath)
  const defs = await withTimeout(
    vscode.commands.executeCommand<unknown[]>(
      "vscode.executeDefinitionProvider",
      uri,
      new vscode.Position(position.line, position.character),
    ),
    timeout,
  )
  if (!defs) return []
  return defs.flatMap(normalize)
}

export async function readQwenRange(filepath: string, range: Range, timeout: number): Promise<string | null> {
  const text = await readQwenFile(vscode.Uri.file(filepath), timeout)
  if (text === null) return null
  const lines = text.split(/\r?\n/)
  return text.slice(offset(lines, range.start), offset(lines, range.end))
}

export async function readQwenFile(uri: vscode.Uri, timeout: number): Promise<string | null> {
  const bytes = await withTimeout(vscode.workspace.fs.readFile(uri), timeout)
  if (!bytes) return null
  return new TextDecoder().decode(bytes)
}

function normalize(def: unknown): QwenDefinition[] {
  if (!def || typeof def !== "object") return []
  const item = def as {
    uri?: vscode.Uri
    range?: Range
    targetUri?: vscode.Uri
    targetRange?: Range
  }
  const uri = item.targetUri ?? item.uri
  const range = item.targetRange ?? item.range
  if (!uri || uri.scheme !== "file" || !rangeInfo(range)) return []
  return [{ filepath: uri.fsPath || uri.path, range }]
}

async function withTimeout<T>(promise: PromiseLike<T>, timeout: number): Promise<T | null> {
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ])
  } catch (err) {
    void err
    return null
  }
}

function offset(lines: string[], pos: Pos): number {
  return lines.slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.character
}

function rangeInfo(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false
  const current = value as { start?: unknown; end?: unknown }
  return point(current.start) && point(current.end)
}

function point(value: unknown): value is Pos {
  if (!value || typeof value !== "object") return false
  const current = value as { line?: unknown; character?: unknown }
  return typeof current.line === "number" && typeof current.character === "number"
}
