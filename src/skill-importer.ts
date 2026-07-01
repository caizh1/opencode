import { homedir } from "node:os"
import * as nodePath from "node:path"
import * as vscode from "vscode"
import {
  extractSkillReferencedResourceFiles,
  normalizeSkillAllowedTools,
  normalizeSkillCommandName,
  parseSkillMarkdown,
  SKILL_FILE_NAME,
  SKILL_RESOURCE_DIRS,
  VALID_SKILL_TOOL_NAME,
  type SkillMetadata,
} from "./skills"
import type { RemoteSettings } from "./types"

const MAX_IMPORT_FILES = 500
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 10 * 1024 * 1024
const HOST_SKILL_ROOTS = [".agents/skills", ".opencode/skills", ".claude/skills", ".codex/skills"] as const
const HOST_ROOT_DIRS = new Set([".agents", ".opencode", ".claude", ".codex"])

export type SkillImportCandidate = {
  source: vscode.Uri
  sourcePath: string
  sourceKind: "skill-directory" | "skill-file"
  skillRoot: string
  skillFile: string
  standaloneFile: boolean
}

export type SkillImportCopyFile = {
  source: vscode.Uri
  relativePath: string
  bytes: number
}

export type SkillImportValidationResult = {
  valid: boolean
  sourcePath: string
  sourceKind: SkillImportCandidate["sourceKind"] | "parent-directory" | "unsupported"
  skillRoot: string
  skillFile: string
  standaloneFile: boolean
  name: string
  commandName: string
  id: string
  description: string
  targetRoot: string
  targetPath: string
  allowedTools: string[]
  resourceFiles: string[]
  filesToCopy: SkillImportCopyFile[]
  totalBytes: number
  errors: string[]
  warnings: string[]
}

export type SkillImportResult = {
  imported: Array<{
    id: string
    name: string
    commandName: string
    targetPath: string
    warnings: string[]
  }>
  skipped: Array<{
    sourcePath: string
    name?: string
    reason: string
  }>
  invalid: SkillImportValidationResult[]
  warnings: string[]
  enabledSkillIdsAdded: string[]
  targetRoot: string
}

type SkillImportSettings = RemoteSettings["skills"]

type ValidateSkillImportSourcesInput = {
  sources: vscode.Uri[]
  userHome?: string
  settings: SkillImportSettings
}

type ImportSkillsInput = ValidateSkillImportSourcesInput & {
  existingSkills?: Array<Pick<SkillMetadata, "name" | "scope" | "path">>
  confirmOverwrite?: (candidate: SkillImportValidationResult) => Promise<boolean>
  saveEnabledSkills?: (enabled: string[]) => Promise<void>
  output?: vscode.OutputChannel
}

type ExpandedImportSource =
  | { kind: "candidate"; candidate: SkillImportCandidate }
  | { kind: "invalid"; sourcePath: string; sourceKind: SkillImportValidationResult["sourceKind"]; errors: string[]; warnings?: string[] }

export function userAgentsSkillRoot(userHome = homedir()) {
  return nodePath.join(userHome, ".agents", "skills")
}

export async function validateSkillImportSources(input: ValidateSkillImportSourcesInput): Promise<SkillImportValidationResult[]> {
  const targetRoot = userAgentsSkillRoot(input.userHome)
  const expanded = await expandImportSources(input.sources)
  const seen = new Set<string>()
  const results: SkillImportValidationResult[] = []
  for (const item of expanded) {
    const key = item.kind === "candidate" ? item.candidate.skillFile : `${item.sourceKind}:${item.sourcePath}`
    if (seen.has(key)) continue
    seen.add(key)
    if (item.kind === "invalid") {
      results.push(emptyValidation({
        sourcePath: item.sourcePath,
        sourceKind: item.sourceKind,
        targetRoot,
        errors: item.errors,
        warnings: item.warnings ?? [],
      }))
      continue
    }
    results.push(await validateSkillCandidate(item.candidate, targetRoot))
  }
  return results
}

export async function importSkills(input: ImportSkillsInput): Promise<SkillImportResult> {
  const validations = await validateSkillImportSources(input)
  const targetRoot = userAgentsSkillRoot(input.userHome)
  const result: SkillImportResult = {
    imported: [],
    skipped: [],
    invalid: validations.filter((candidate) => !candidate.valid),
    warnings: [],
    enabledSkillIdsAdded: [],
    targetRoot,
  }
  for (const invalid of result.invalid) {
    input.output?.appendLine(`[skills-import] invalid source=${invalid.sourcePath} errors=${invalid.errors.join("; ")}`)
  }

  for (const candidate of validations.filter((item) => item.valid)) {
    const exists = await uriExists(vscode.Uri.file(candidate.targetPath))
    if (exists) {
      const overwrite = input.confirmOverwrite ? await input.confirmOverwrite(candidate) : false
      if (!overwrite) {
        result.skipped.push({
          sourcePath: candidate.sourcePath,
          name: candidate.name,
          reason: `target already exists: ${candidate.targetPath}`,
        })
        input.output?.appendLine(`[skills-import] skipped name=${candidate.name} reason=target-exists target=${candidate.targetPath}`)
        continue
      }
      await vscode.workspace.fs.delete(vscode.Uri.file(candidate.targetPath), { recursive: true, useTrash: false })
      input.output?.appendLine(`[skills-import] overwrite name=${candidate.name} target=${candidate.targetPath}`)
    }

    await copySkillCandidate(candidate)
    const warnings = [...candidate.warnings]
    const shadow = input.existingSkills?.find((skill) => skill.scope !== "user" && skill.name.toLowerCase() === candidate.name.toLowerCase())
    if (shadow) {
      const warning = `Imported skill ${candidate.name} is shadowed by ${shadow.scope} skill at ${shadow.path}`
      warnings.push(warning)
      result.warnings.push(warning)
    }
    if (isExplicitlyOff(input.settings, candidate)) {
      const warning = `Imported skill ${candidate.name} is disabled by skills.overrides`
      warnings.push(warning)
      result.warnings.push(warning)
    }
    result.imported.push({
      id: candidate.id,
      name: candidate.name,
      commandName: candidate.commandName,
      targetPath: candidate.targetPath,
      warnings,
    })
    input.output?.appendLine(`[skills-import] imported name=${candidate.name} id=${candidate.id} files=${candidate.filesToCopy.length} target=${candidate.targetPath}`)
  }

  const legacyEnabled = Array.isArray(input.settings.enabled) ? input.settings.enabled.filter(Boolean) : []
  if (legacyEnabled.length > 0 && result.imported.length > 0) {
    const enabled = [...legacyEnabled]
    const seen = new Set(enabled)
    for (const item of result.imported) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      enabled.push(item.id)
      result.enabledSkillIdsAdded.push(item.id)
    }
    if (result.enabledSkillIdsAdded.length > 0) await input.saveEnabledSkills?.(enabled)
  }

  input.output?.appendLine(`[skills-import] summary imported=${result.imported.length} invalid=${result.invalid.length} skipped=${result.skipped.length}`)
  return result
}

async function expandImportSources(sources: vscode.Uri[]): Promise<ExpandedImportSource[]> {
  const expanded: ExpandedImportSource[] = []
  for (const source of sources) {
    const sourcePath = source.fsPath
    let stat: vscode.FileStat
    try {
      stat = await vscode.workspace.fs.stat(source)
    } catch (error) {
      expanded.push({
        kind: "invalid",
        sourcePath,
        sourceKind: "unsupported",
        errors: [`source is not readable: ${formatErrorMessage(error)}`],
      })
      continue
    }
    if (isSymlink(stat)) {
      expanded.push({
        kind: "invalid",
        sourcePath,
        sourceKind: "unsupported",
        errors: ["symlink sources are not supported"],
      })
      continue
    }
    if (stat.type & vscode.FileType.File) {
      if (nodePath.basename(sourcePath) !== SKILL_FILE_NAME) {
        expanded.push({
          kind: "invalid",
          sourcePath,
          sourceKind: "unsupported",
          errors: [`only ${SKILL_FILE_NAME} files can be imported directly`],
        })
        continue
      }
      expanded.push({
        kind: "candidate",
        candidate: {
          source,
          sourcePath,
          sourceKind: "skill-file",
          skillRoot: nodePath.dirname(sourcePath),
          skillFile: sourcePath,
          standaloneFile: true,
        },
      })
      continue
    }
    if (!(stat.type & vscode.FileType.Directory)) {
      expanded.push({
        kind: "invalid",
        sourcePath,
        sourceKind: "unsupported",
        errors: ["source must be a skill directory, parent directory, or SKILL.md file"],
      })
      continue
    }

    const directSkillFile = nodePath.join(sourcePath, SKILL_FILE_NAME)
    if (await isRegularFile(directSkillFile)) {
      expanded.push({
        kind: "candidate",
        candidate: {
          source,
          sourcePath,
          sourceKind: "skill-directory",
          skillRoot: sourcePath,
          skillFile: directSkillFile,
          standaloneFile: false,
        },
      })
      continue
    }

    let childCandidates = await collectChildSkillCandidates(sourcePath, expanded)
    for (const hostRoot of hostSkillRootsForImportSource(sourcePath)) {
      childCandidates += await collectChildSkillCandidates(hostRoot, expanded)
    }
    if (childCandidates === 0) {
      expanded.push({
        kind: "invalid",
        sourcePath,
        sourceKind: "parent-directory",
        errors: [`no ${SKILL_FILE_NAME} found in this directory or its immediate child directories`],
      })
    }
  }
  return expanded
}

async function collectChildSkillCandidates(sourceRoot: string, expanded: ExpandedImportSource[]) {
  let childCandidates = 0
  const childEntries = await readDirectorySorted(vscode.Uri.file(sourceRoot))
  for (const [entry, fileType] of childEntries) {
    if (!(fileType & vscode.FileType.Directory)) continue
    const childRoot = nodePath.join(sourceRoot, entry)
    const childStat = await statSafe(childRoot)
    if (!childStat || isSymlink(childStat)) {
      expanded.push({
        kind: "invalid",
        sourcePath: childRoot,
        sourceKind: "unsupported",
        errors: ["symlink skill directories are not supported"],
      })
      continue
    }
    const skillFile = nodePath.join(childRoot, SKILL_FILE_NAME)
    if (!(await isRegularFile(skillFile))) continue
    childCandidates += 1
    expanded.push({
      kind: "candidate",
      candidate: {
        source: vscode.Uri.file(childRoot),
        sourcePath: childRoot,
        sourceKind: "skill-directory",
        skillRoot: childRoot,
        skillFile,
        standaloneFile: false,
      },
    })
  }
  return childCandidates
}

function hostSkillRootsForImportSource(sourcePath: string) {
  const roots = HOST_SKILL_ROOTS.map((root) => nodePath.join(sourcePath, ...root.split("/")))
  if (HOST_ROOT_DIRS.has(nodePath.basename(sourcePath))) roots.push(nodePath.join(sourcePath, "skills"))
  return roots
}

async function validateSkillCandidate(candidate: SkillImportCandidate, targetRoot: string): Promise<SkillImportValidationResult> {
  const errors: string[] = []
  const warnings: string[] = []
  let body = ""
  let frontmatter: Record<string, unknown> = {}

  try {
    const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(candidate.skillFile)))
    if (!hasYamlFrontmatter(raw)) errors.push("SKILL.md must include YAML frontmatter")
    const parsed = parseSkillMarkdown(raw, candidate.skillFile)
    body = parsed.body
    frontmatter = parsed.frontmatter as Record<string, unknown>
  } catch (error) {
    errors.push(`invalid skill frontmatter: ${formatErrorMessage(error)}`)
  }

  const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : ""
  let name = frontmatterName
  if (!name) {
    if (candidate.standaloneFile) {
      errors.push(`name is required when importing a standalone ${SKILL_FILE_NAME}`)
    } else {
      name = nodePath.basename(candidate.skillRoot)
      warnings.push("name missing; defaulted from skill directory")
    }
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""
  if (!description) errors.push("description is required")
  const commandName = normalizeSkillCommandName(name)
  if (!commandName) errors.push("name must contain at least one command-safe character")

  const rawAllowedTools = frontmatter["allowed-tools"] ?? frontmatter.allowedTools
  const invalidAllowedToolTypes = invalidAllowedToolEntries(rawAllowedTools)
  for (const tool of invalidAllowedToolTypes) errors.push(`invalid allowed-tools entry: ${tool}`)
  const allowedTools = normalizeSkillAllowedTools(readStringOrStringArray(rawAllowedTools))
  for (const tool of allowedTools) {
    if (!VALID_SKILL_TOOL_NAME.test(tool)) errors.push(`invalid allowed-tools entry: ${tool}`)
  }

  const copyPlan = await collectCopyPlan(candidate.skillRoot, candidate.skillFile, warnings, errors)
  const resourceFiles = copyPlan.files
    .map((file) => file.relativePath)
    .filter((relativePath) => SKILL_RESOURCE_DIRS.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`)))
    .sort()
  for (const resource of extractSkillReferencedResourceFiles(body)) {
    if (!resourceFiles.includes(resource)) errors.push(`referenced resource not found: ${resource}`)
  }
  if (copyPlan.files.length > MAX_IMPORT_FILES) errors.push(`skill import exceeds ${MAX_IMPORT_FILES} files`)
  if (copyPlan.totalBytes > MAX_TOTAL_BYTES) errors.push(`skill import exceeds ${formatBytes(MAX_TOTAL_BYTES)} total size`)

  const targetPath = commandName ? nodePath.join(targetRoot, commandName) : ""
  return {
    valid: errors.length === 0,
    sourcePath: candidate.sourcePath,
    sourceKind: candidate.sourceKind,
    skillRoot: candidate.skillRoot,
    skillFile: candidate.skillFile,
    standaloneFile: candidate.standaloneFile,
    name,
    commandName,
    id: name ? `user:${name}` : "",
    description,
    targetRoot,
    targetPath,
    allowedTools,
    resourceFiles,
    filesToCopy: copyPlan.files,
    totalBytes: copyPlan.totalBytes,
    errors,
    warnings,
  }
}

async function collectCopyPlan(skillRoot: string, skillFile: string, warnings: string[], errors: string[]) {
  const files: SkillImportCopyFile[] = []
  let totalBytes = 0
  const addFile = async (absolutePath: string, relativePath: string) => {
    const normalizedRelativePath = normalizeRelativePath(relativePath)
    if (!normalizedRelativePath) return
    if (normalizedRelativePath.startsWith("../") || nodePath.isAbsolute(normalizedRelativePath)) {
      errors.push(`path escapes skill root: ${relativePath}`)
      return
    }
    const stat = await statSafe(absolutePath)
    if (!stat) {
      errors.push(`file is not readable: ${normalizedRelativePath}`)
      return
    }
    if (isSymlink(stat)) {
      errors.push(`symlink files are not supported: ${normalizedRelativePath}`)
      return
    }
    if (!(stat.type & vscode.FileType.File)) return
    if (stat.size > MAX_FILE_BYTES) errors.push(`file exceeds ${formatBytes(MAX_FILE_BYTES)}: ${normalizedRelativePath}`)
    totalBytes += stat.size
    files.push({
      source: vscode.Uri.file(absolutePath),
      relativePath: normalizedRelativePath,
      bytes: stat.size,
    })
  }

  await addFile(skillFile, SKILL_FILE_NAME)
  const entries = await readDirectorySorted(vscode.Uri.file(skillRoot))
  for (const [entry, fileType] of entries) {
    if (entry === SKILL_FILE_NAME) continue
    const absolutePath = nodePath.join(skillRoot, entry)
    const entryStat = await statSafe(absolutePath)
    if (entryStat && isSymlink(entryStat)) {
      errors.push(`symlink entries are not supported: ${entry}`)
      continue
    }
    if (SKILL_RESOURCE_DIRS.includes(entry as (typeof SKILL_RESOURCE_DIRS)[number])) {
      if (fileType & vscode.FileType.Directory) {
        await collectResourceFiles(absolutePath, entry, addFile, errors)
        continue
      }
      warnings.push(`resource entry skipped because it is not a directory: ${entry}`)
      continue
    }
    warnings.push(`unsupported import entry skipped: ${entry}`)
  }
  return { files, totalBytes }
}

async function collectResourceFiles(
  root: string,
  relativeRoot: string,
  addFile: (absolutePath: string, relativePath: string) => Promise<void>,
  errors: string[],
): Promise<void> {
  const stat = await statSafe(root)
  if (!stat) return
  if (isSymlink(stat)) {
    errors.push(`symlink directories are not supported: ${relativeRoot}`)
    return
  }
  if (!(stat.type & vscode.FileType.Directory)) return
  const entries = await readDirectorySorted(vscode.Uri.file(root))
  for (const [entry, fileType] of entries) {
    const absolutePath = nodePath.join(root, entry)
    const relativePath = normalizeRelativePath(nodePath.join(relativeRoot, entry))
    if (fileType & vscode.FileType.Directory) {
      await collectResourceFiles(absolutePath, relativePath, addFile, errors)
      continue
    }
    if (fileType & vscode.FileType.File) await addFile(absolutePath, relativePath)
  }
}

async function copySkillCandidate(candidate: SkillImportValidationResult) {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(candidate.targetPath))
  for (const file of candidate.filesToCopy) {
    const targetPath = nodePath.join(candidate.targetPath, ...file.relativePath.split("/"))
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(nodePath.dirname(targetPath)))
    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetPath), await vscode.workspace.fs.readFile(file.source))
  }
}

function isExplicitlyOff(settings: SkillImportSettings, candidate: SkillImportValidationResult) {
  const overrides = settings.overrides && typeof settings.overrides === "object" ? settings.overrides : {}
  return overrides[candidate.id] === "off" || overrides[candidate.name] === "off" || overrides[candidate.commandName] === "off"
}

function emptyValidation(input: {
  sourcePath: string
  sourceKind: SkillImportValidationResult["sourceKind"]
  targetRoot: string
  errors: string[]
  warnings?: string[]
}): SkillImportValidationResult {
  return {
    valid: false,
    sourcePath: input.sourcePath,
    sourceKind: input.sourceKind,
    skillRoot: "",
    skillFile: "",
    standaloneFile: false,
    name: "",
    commandName: "",
    id: "",
    description: "",
    targetRoot: input.targetRoot,
    targetPath: "",
    allowedTools: [],
    resourceFiles: [],
    filesToCopy: [],
    totalBytes: 0,
    errors: input.errors,
    warnings: input.warnings ?? [],
  }
}

async function readDirectorySorted(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return (await vscode.workspace.fs.readDirectory(uri)).sort((left, right) => left[0].localeCompare(right[0]))
  } catch {
    return []
  }
}

async function isRegularFile(path: string) {
  const stat = await statSafe(path)
  return Boolean(stat && !isSymlink(stat) && stat.type & vscode.FileType.File)
}

async function uriExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

async function statSafe(path: string) {
  try {
    return await vscode.workspace.fs.stat(vscode.Uri.file(path))
  } catch {
    return undefined
  }
}

function isSymlink(stat: vscode.FileStat) {
  return Boolean(stat.type & vscode.FileType.SymbolicLink)
}

function hasYamlFrontmatter(content: string) {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(content)
}

function readStringOrStringArray(input: unknown) {
  if (typeof input === "string") return input
  if (Array.isArray(input) && input.every((item) => typeof item === "string")) return input
  return undefined
}

function invalidAllowedToolEntries(input: unknown) {
  if (input === undefined || input === null || typeof input === "string") return []
  if (Array.isArray(input)) return input.filter((item) => typeof item !== "string").map((item) => String(item))
  return [String(input)]
}

function normalizeRelativePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "")
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
