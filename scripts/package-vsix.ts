import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface PackageManifest {
  name?: unknown
  version?: unknown
  [key: string]: unknown
}

interface ResolvePackageVsixVersionInput {
  currentVersion: string
  release?: string
  build?: string
}

interface PackageBuildVersion {
  release: string
  build: number
}

type LocalDefaultValue = string | string[]

const CORE_RELEASE_PATTERN = /^\d+\.\d+\.\d+$/
const BUILD_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-build\.(\d+)$/
const LOCAL_DEFAULTS_FILENAME = ".chipmate-vsix-defaults.local.json"
const LOCAL_DEFAULT_SETTING_SPECS = [
  { setting: "chipmate.provider.apiBaseUrl", path: ["provider", "apiBaseUrl"], kind: "string" },
  { setting: "chipmate.provider.chatModel", path: ["provider", "chatModel"], kind: "string" },
  { setting: "chipmate.rag.embedding.endpoint", path: ["rag", "embedding", "endpoint"], kind: "string" },
  { setting: "chipmate.rag.embedding.model", path: ["rag", "embedding", "model"], kind: "string" },
  { setting: "chipmate.rag.rerank.endpoint", path: ["rag", "rerank", "endpoint"], kind: "string" },
  { setting: "chipmate.rag.rerank.model", path: ["rag", "rerank", "model"], kind: "string" },
  { setting: "chipmate.rag.allowedHosts", path: ["rag", "allowedHosts"], kind: "stringArray" },
] as const

export function resolvePackageVsixVersion(input: ResolvePackageVsixVersionInput) {
  const current = parsePackageBuildVersion(input.currentVersion)
  const release = input.release ?? current?.release
  if (!release || !CORE_RELEASE_PATTERN.test(release)) {
    throw new Error("Pass --release <x.y.z> to start a build-number version line.")
  }

  const build = input.build !== undefined
    ? parsePositiveInteger(input.build, "--build")
    : current?.release === release
      ? current.build + 1
      : 1

  return `${release}-build.${build}`
}

export function parsePackageBuildVersion(version: string): PackageBuildVersion | undefined {
  const match = version.trim().match(BUILD_VERSION_PATTERN)
  if (!match) return undefined
  return {
    release: match[1],
    build: parsePositiveInteger(match[2], "build number"),
  }
}

export function parsePackageVsixCliArgs(args: string[]) {
  const options: { release?: string; build?: string; help?: boolean } = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--") continue
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    if (arg === "--release") {
      options.release = readOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith("--release=")) {
      options.release = arg.slice("--release=".length)
      continue
    }
    if (arg === "--build") {
      options.build = readOptionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg.startsWith("--build=")) {
      options.build = arg.slice("--build=".length)
      continue
    }

    throw new Error(`Unexpected argument "${arg}". Semantic version bumps like patch/minor/major are disabled; use --release and --build.`)
  }
  return options
}

function readOptionValue(args: string[], index: number, option: string) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`)
  return value
}

function parsePositiveInteger(value: string, label: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a positive integer.`)
  return Number(value)
}

function readPackageManifest(packageJsonPath: string) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageManifest
}

function writePackageManifest(packageJsonPath: string, manifest: PackageManifest) {
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function clonePackageManifest(manifest: PackageManifest) {
  return JSON.parse(JSON.stringify(manifest)) as PackageManifest
}

function requireManifestString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`package.json ${field} must be a non-empty string.`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readNestedValue(source: unknown, path: readonly string[]) {
  let current = source
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${LOCAL_DEFAULTS_FILENAME} ${label} must be a non-empty string.`)
  }
  return value.trim()
}

function requireNonEmptyStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${LOCAL_DEFAULTS_FILENAME} ${label} must be a non-empty string array.`)
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`))
}

export function collectVsixLocalDefaultSettings(rawDefaults: unknown) {
  if (!isRecord(rawDefaults)) {
    throw new Error(`${LOCAL_DEFAULTS_FILENAME} must be a JSON object.`)
  }

  const settings: Record<string, LocalDefaultValue> = {}
  for (const spec of LOCAL_DEFAULT_SETTING_SPECS) {
    const value = readNestedValue(rawDefaults, spec.path)
    settings[spec.setting] = spec.kind === "stringArray"
      ? requireNonEmptyStringArray(value, spec.path.join("."))
      : requireNonEmptyString(value, spec.path.join("."))
  }
  return settings
}

function manifestConfigurationProperties(manifest: PackageManifest) {
  const contributes = manifest.contributes
  if (!isRecord(contributes)) throw new Error("package.json contributes must be an object.")
  const configuration = contributes.configuration
  if (!isRecord(configuration)) throw new Error("package.json contributes.configuration must be an object.")
  const properties = configuration.properties
  if (!isRecord(properties)) throw new Error("package.json contributes.configuration.properties must be an object.")
  return properties
}

export function applyVsixLocalDefaults(manifest: PackageManifest, rawDefaults: unknown) {
  const settings = collectVsixLocalDefaultSettings(rawDefaults)
  const properties = manifestConfigurationProperties(manifest)

  for (const [setting, defaultValue] of Object.entries(settings)) {
    const property = properties[setting]
    if (!isRecord(property)) {
      throw new Error(`package.json setting ${setting} must exist before local VSIX defaults can be injected.`)
    }
    property.default = Array.isArray(defaultValue) ? [...defaultValue] : defaultValue
  }

  return settings
}

function readLocalDefaults(repoRoot: string) {
  const defaultsPath = join(repoRoot, LOCAL_DEFAULTS_FILENAME)
  if (!existsSync(defaultsPath)) return undefined
  assertGitIgnored(repoRoot, LOCAL_DEFAULTS_FILENAME)
  return JSON.parse(readFileSync(defaultsPath, "utf8")) as unknown
}

function assertGitIgnored(repoRoot: string, relativePath: string) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: repoRoot, stdio: "ignore" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${relativePath} must be ignored by git before local VSIX defaults can be used.`)
  }
}

function changedDefaultStrings(baseManifest: PackageManifest, settings: Record<string, LocalDefaultValue>) {
  const properties = manifestConfigurationProperties(baseManifest)
  const changed: string[] = []
  for (const [setting, defaultValue] of Object.entries(settings)) {
    const property = properties[setting]
    if (!isRecord(property)) continue
    if (JSON.stringify(property.default) === JSON.stringify(defaultValue)) continue
    changed.push(...(Array.isArray(defaultValue) ? defaultValue : [defaultValue]))
  }
  return Array.from(new Set(changed.filter((value) => value.trim())))
}

function assertPackageJsonDoesNotContainLocalDefaults(packageJsonPath: string, values: string[]) {
  if (values.length === 0) return
  const source = readFileSync(packageJsonPath, "utf8")
  const leakedCount = values.filter((value) => source.includes(value)).length
  if (leakedCount > 0) {
    throw new Error(`package.json still contains ${leakedCount} local VSIX default value(s) after packaging; refusing to leave private defaults in source.`)
  }
}

function assertTrackedSourceDoesNotContainLocalDefaults(repoRoot: string, values: string[]) {
  for (const value of values) {
    const result = spawnSync("git", ["grep", "--quiet", "--fixed-strings", "-e", value, "--", "."], { cwd: repoRoot, stdio: "ignore" })
    if (result.error) throw result.error
    if (result.status === 0) {
      throw new Error("Tracked source still contains a local VSIX default value after packaging; refusing to leave private defaults in git-tracked files.")
    }
    if (result.status !== 1) {
      throw new Error(`git grep failed while checking local VSIX defaults with exit code ${result.status ?? "unknown"}.`)
    }
  }
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`)
}

function printHelp() {
  console.log([
    "Usage:",
    "  bun run vsix -- --release 0.1.0 --build 1",
    "  bun run vsix",
    "",
    "Without arguments, the current x.y.z-build.N version is packaged as x.y.z-build.(N+1).",
    "Core x.y.z releases only change when --release is provided.",
  ].join("\n"))
}

function main() {
  const repoRoot = join(import.meta.dir, "..")
  const packageJsonPath = join(repoRoot, "package.json")
  const args = parsePackageVsixCliArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const sourceManifest = readPackageManifest(packageJsonPath)
  const name = requireManifestString(sourceManifest.name, "name")
  const currentVersion = requireManifestString(sourceManifest.version, "version")
  const targetVersion = resolvePackageVsixVersion({
    currentVersion,
    release: args.release,
    build: args.build,
  })

  const restoredManifest = clonePackageManifest(sourceManifest)
  restoredManifest.version = targetVersion
  const packagedManifest = clonePackageManifest(restoredManifest)
  const rawLocalDefaults = readLocalDefaults(repoRoot)
  const localDefaultSettings = rawLocalDefaults === undefined
    ? undefined
    : applyVsixLocalDefaults(packagedManifest, rawLocalDefaults)
  const localDefaultLeakCheckValues = localDefaultSettings
    ? changedDefaultStrings(restoredManifest, localDefaultSettings)
    : []
  const outputName = `${name}-${targetVersion}.vsix`
  console.log(`Packaging ChipMate VSIX ${currentVersion} -> ${targetVersion}`)
  if (localDefaultSettings) {
    console.log(`Applying local VSIX defaults from ${LOCAL_DEFAULTS_FILENAME} (${Object.keys(localDefaultSettings).length} setting(s)).`)
  }
  run("bun", ["scripts/verify-drawio-runtime.ts"], repoRoot)

  writePackageManifest(packageJsonPath, packagedManifest)
  try {
    run("vsce", ["package", "--out", outputName], repoRoot)
  } finally {
    writePackageManifest(packageJsonPath, restoredManifest)
    assertPackageJsonDoesNotContainLocalDefaults(packageJsonPath, localDefaultLeakCheckValues)
    assertTrackedSourceDoesNotContainLocalDefaults(repoRoot, localDefaultLeakCheckValues)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
