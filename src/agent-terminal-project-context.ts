import { open, readdir, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

const DEFAULT_MAX_ASCEND = 8
const DEFAULT_MAX_DOC_SCAN = 120
const DEFAULT_MAX_SNIPPETS = 6
const DEFAULT_MAX_SNIPPET_BYTES = 1200
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".vscode-test", ".cache"])
const ROOT_MARKERS = new Set([
  ".git",
  "configure",
  "meson.build",
  "CMakeLists.txt",
  "Makefile",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "compile_commands.json",
])
const BUILD_MARKERS = new Set([
  "configure",
  "meson.build",
  "CMakeLists.txt",
  "Makefile",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "compile_commands.json",
])

export type TerminalProjectContextSnippet = {
  path: string
  kind: "readme" | "doc"
  text: string
  truncated: boolean
}

export type TerminalProjectContext = {
  cwd: string
  root: string
  relativeCwd: string
  rootFiles: string[]
  buildFiles: string[]
  buildDirectories: string[]
  docs: string[]
  snippets: TerminalProjectContextSnippet[]
  hints: string[]
  truncated: boolean
  errors: string[]
}

export type InspectTerminalProjectContextInput = {
  cwd: string
  signal?: AbortSignal
  maxAscend?: number
  maxDocScan?: number
  maxSnippets?: number
  maxSnippetBytes?: number
}

type DirEntry = {
  name: string
  isFile: boolean
  isDirectory: boolean
}

export async function inspectTerminalProjectContext(input: InspectTerminalProjectContextInput): Promise<TerminalProjectContext> {
  const cwd = resolve(input.cwd)
  const errors: string[] = []
  const root = await findProjectRoot(cwd, input.maxAscend ?? DEFAULT_MAX_ASCEND, input.signal, errors)
  const rootEntries = await safeReadDir(root, errors, input.signal)
  const rootFiles = rootEntries
    .filter((entry) => entry.isFile && isInterestingRootFile(entry.name))
    .map((entry) => entry.name)
    .sort(compareRootFile)
  const rootDirs = rootEntries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort(comparePath)
  const buildFiles = rootFiles.filter((name) => BUILD_MARKERS.has(name))
  const buildDirectories = rootDirs.filter(isBuildDirectory)
  const docsResult = await findRelevantDocs(root, input.maxDocScan ?? DEFAULT_MAX_DOC_SCAN, input.signal, errors)
  const snippetPaths = uniquePaths([
    ...rootFiles.filter((name) => /^readme(?:[._-].*)?$/i.test(name) || /^readme\./i.test(name)).slice(0, 2),
    ...docsResult.paths,
  ]).slice(0, input.maxSnippets ?? DEFAULT_MAX_SNIPPETS)
  const snippets = await readSnippets(root, snippetPaths, input.maxSnippetBytes ?? DEFAULT_MAX_SNIPPET_BYTES, input.signal, errors)
  const truncated = docsResult.truncated || snippets.some((snippet) => snippet.truncated)
  return {
    cwd,
    root,
    relativeCwd: relative(root, cwd) || ".",
    rootFiles,
    buildFiles,
    buildDirectories,
    docs: docsResult.paths,
    snippets,
    hints: buildHints(buildFiles, buildDirectories),
    truncated,
    errors,
  }
}

export function terminalProjectContextPrompt(context: TerminalProjectContext) {
  return [
    `Project root: ${context.root}`,
    `Relative cwd: ${context.relativeCwd}`,
    `Detected root files: ${formatList(context.rootFiles)}`,
    `Build files: ${formatList(context.buildFiles)}`,
    `Build system hints: ${formatList(context.hints)}`,
    `Existing build directories: ${formatList(context.buildDirectories)}`,
    `Relevant docs: ${formatList(context.docs)}`,
    context.snippets.length ? `Evidence snippets:\n${context.snippets.map(formatSnippet).join("\n\n")}` : "Evidence snippets: none",
    context.errors.length ? `Inspection warnings:\n${context.errors.map((error) => `- ${error}`).join("\n")}` : "Inspection warnings: none",
    `Truncated: ${context.truncated ? "yes" : "no"}`,
  ].join("\n")
}

export function terminalProjectContextSummaryLines(context: TerminalProjectContext) {
  const found = uniquePaths([...context.buildFiles, ...context.rootFiles.filter((name) => /^readme/i.test(name))]).slice(0, 8)
  const lines = [`  found: ${found.length ? found.join(", ") : "none"}`]
  if (context.buildDirectories.length) lines.push(`  build dirs: ${context.buildDirectories.slice(0, 4).join(", ")}`)
  if (context.docs.length) lines.push(`  docs: ${context.docs.slice(0, 4).join(", ")}`)
  if (context.truncated) lines.push("  note: project inspection was truncated")
  if (context.errors.length) lines.push(`  warning: ${context.errors[0]}`)
  return lines
}

async function findProjectRoot(cwd: string, maxAscend: number, signal: AbortSignal | undefined, errors: string[]) {
  let current = await directoryFor(cwd, errors)
  for (let depth = 0; depth <= maxAscend; depth += 1) {
    throwIfAborted(signal)
    const names = new Set((await safeReadDir(current, errors, signal)).map((entry) => entry.name))
    if ([...ROOT_MARKERS].some((marker) => names.has(marker))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return cwd
}

async function directoryFor(path: string, errors: string[]) {
  try {
    const info = await stat(path)
    return info.isDirectory() ? path : dirname(path)
  } catch (error) {
    errors.push(`Could not stat cwd ${path}: ${formatErrorMessage(error)}`)
    return path
  }
}

async function safeReadDir(dir: string, errors: string[], signal: AbortSignal | undefined): Promise<DirEntry[]> {
  throwIfAborted(signal)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    }))
  } catch (error) {
    errors.push(`Could not read directory ${dir}: ${formatErrorMessage(error)}`)
    return []
  }
}

async function findRelevantDocs(root: string, maxScan: number, signal: AbortSignal | undefined, errors: string[]) {
  const docsRoot = join(root, "docs")
  const paths: string[] = []
  let scanned = 0
  let truncated = false

  if (!(await isDirectory(docsRoot))) return { paths, truncated }

  const visit = async (dir: string, depth: number) => {
    if (depth > 4 || truncated) return
    throwIfAborted(signal)
    const entries = await safeReadDir(dir, errors, signal)
    for (const entry of entries.sort((left, right) => comparePath(left.name, right.name))) {
      if (scanned >= maxScan) {
        truncated = true
        return
      }
      if (entry.isDirectory) {
        if (!SKIP_DIRS.has(entry.name)) await visit(join(dir, entry.name), depth + 1)
        continue
      }
      scanned += 1
      const absolute = join(dir, entry.name)
      const relativePath = toPosix(relative(root, absolute))
      if (entry.isFile && isRelevantDocPath(relativePath)) paths.push(relativePath)
    }
  }

  await visit(docsRoot, 0)
  return { paths: uniquePaths(paths).slice(0, 8), truncated }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function readSnippets(
  root: string,
  paths: string[],
  maxBytes: number,
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<TerminalProjectContextSnippet[]> {
  const snippets: TerminalProjectContextSnippet[] = []
  for (const path of paths) {
    throwIfAborted(signal)
    const absolute = join(root, path)
    try {
      const file = await open(absolute, "r")
      try {
        const buffer = Buffer.alloc(maxBytes + 1)
        const { bytesRead } = await file.read(buffer, 0, maxBytes + 1, 0)
        snippets.push({
          path,
          kind: /^readme/i.test(basename(path)) ? "readme" : "doc",
          text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8").trim(),
          truncated: bytesRead > maxBytes,
        })
      } finally {
        await file.close()
      }
    } catch (error) {
      errors.push(`Could not read ${path}: ${formatErrorMessage(error)}`)
    }
  }
  return snippets
}

function isInterestingRootFile(name: string) {
  return BUILD_MARKERS.has(name) || /^readme(?:[._-].*)?$/i.test(name) || /^readme\./i.test(name)
}

function isRelevantDocPath(path: string) {
  return /\.(?:md|rst|txt)$/i.test(path) && /(?:build|install|compile|run|quickstart)/i.test(path)
}

function isBuildDirectory(name: string) {
  return name === "build" || /^build[-_.]/i.test(name)
}

function buildHints(files: string[], dirs: string[]) {
  const hints: string[] = []
  if (files.includes("configure")) hints.push("configure script")
  if (files.includes("meson.build")) hints.push("Meson")
  if (files.includes("CMakeLists.txt")) hints.push("CMake")
  if (files.includes("Makefile")) hints.push("Make")
  if (files.includes("package.json")) hints.push("Node.js package")
  if (files.includes("Cargo.toml")) hints.push("Rust Cargo")
  if (files.includes("go.mod")) hints.push("Go module")
  if (files.includes("pyproject.toml")) hints.push("Python project")
  if (files.includes("compile_commands.json")) hints.push("compile_commands.json")
  if (dirs.length) hints.push("existing build directory")
  return hints
}

function formatSnippet(snippet: TerminalProjectContextSnippet) {
  const suffix = snippet.truncated ? " (truncated)" : ""
  return `--- ${snippet.path}${suffix} ---\n${snippet.text}`
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean))]
}

function formatList(values: string[]) {
  return values.length ? values.join(", ") : "none"
}

function compareRootFile(left: string, right: string) {
  const priority = ["configure", "meson.build", "CMakeLists.txt", "Makefile", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "compile_commands.json"]
  const leftIndex = priority.indexOf(left)
  const rightIndex = priority.indexOf(right)
  if (leftIndex >= 0 || rightIndex >= 0) {
    if (leftIndex < 0) return 1
    if (rightIndex < 0) return -1
    return leftIndex - rightIndex
  }
  return comparePath(left, right)
}

function comparePath(left: string, right: string) {
  return left.localeCompare(right)
}

function toPosix(path: string) {
  return path.replace(/\\/g, "/")
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Project inspection aborted.")
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
