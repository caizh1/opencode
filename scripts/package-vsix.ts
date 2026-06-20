import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
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

const CORE_RELEASE_PATTERN = /^\d+\.\d+\.\d+$/
const BUILD_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-build\.(\d+)$/

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

function requireManifestString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`package.json ${field} must be a non-empty string.`)
  return value.trim()
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

  const manifest = readPackageManifest(packageJsonPath)
  const name = requireManifestString(manifest.name, "name")
  const currentVersion = requireManifestString(manifest.version, "version")
  const targetVersion = resolvePackageVsixVersion({
    currentVersion,
    release: args.release,
    build: args.build,
  })

  if (currentVersion !== targetVersion) {
    manifest.version = targetVersion
    writePackageManifest(packageJsonPath, manifest)
  }

  const outputName = `${name}-${targetVersion}.vsix`
  console.log(`Packaging ChipMate VSIX ${currentVersion} -> ${targetVersion}`)
  run("vsce", ["package", "--out", outputName], repoRoot)
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
