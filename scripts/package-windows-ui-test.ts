import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

type CliOptions = {
  out?: string
  includeVscode?: string
  nodeWinX64?: string
  keepStage?: boolean
}

const REQUIRED_SOURCE_DIRS = [
  "test/ui-windows/windows",
  "test/ui-windows/fixtures",
  "test/ui-windows/runner",
] as const

const SECRET_PATTERNS = [
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/i,
  /"apiKey"\s*:\s*"(?!\s*"|\[REDACTED\]|<)[^"]{8,}"/i,
  /(?:^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}/i,
]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.nodeWinX64) {
    throw new Error("Usage: bun scripts/package-windows-ui-test.ts --node-win-x64 <dir-containing-node.exe> [--out <dir>] [--include-vscode <path>]")
  }

  const repoRoot = resolve(join(import.meta.dir, ".."))
  for (const dir of REQUIRED_SOURCE_DIRS) {
    if (!existsSync(join(repoRoot, dir))) throw new Error(`Required source directory missing: ${dir}`)
  }

  const stamp = bundleStamp()
  const bundleName = `${options.includeVscode ? "chipmate-ui-runner-windows-with-vscode" : "chipmate-ui-runner-windows"}-${stamp}`
  const outDir = resolve(options.out ?? repoRoot)
  const stage = mkdtempSync(join(tmpdir(), `${bundleName}-stage-`))
  const bundleRoot = join(stage, bundleName)

  try {
    await mkdir(bundleRoot, { recursive: true })
    await copyWindowsHarness(repoRoot, bundleRoot)
    await buildAndCopyRunner(repoRoot, bundleRoot)
    await copyFixtures(repoRoot, bundleRoot)
    await copyNodeRuntime(options.nodeWinX64, bundleRoot)
    await copyOptionalVscode(options.includeVscode, bundleRoot)
    await writeRunnerMetadata(bundleRoot, bundleName, Boolean(options.includeVscode))
    await assertNoBundledSecrets(bundleRoot)
    await mkdir(outDir, { recursive: true })
    const zipPath = join(outDir, `${bundleName}.zip`)
    rmSync(zipPath, { force: true })
    run("zip", ["-qr", zipPath, bundleName], stage)
    const zipSha = sha256File(zipPath)
    writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${basename(zipPath)}\n`)
    console.log(`windowsUiRunnerBundle=${zipPath}`)
    console.log(`windowsUiRunnerBundleSha256=${zipSha}`)
    if (options.keepStage) console.log(`stage=${bundleRoot}`)
  } finally {
    if (!options.keepStage) rmSync(stage, { recursive: true, force: true })
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--") continue
    if (arg === "--out") {
      options.out = readValue(args, ++index, arg)
      continue
    }
    if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length)
      continue
    }
    if (arg === "--include-vscode") {
      options.includeVscode = readValue(args, ++index, arg)
      continue
    }
    if (arg.startsWith("--include-vscode=")) {
      options.includeVscode = arg.slice("--include-vscode=".length)
      continue
    }
    if (arg === "--node-win-x64") {
      options.nodeWinX64 = readValue(args, ++index, arg)
      continue
    }
    if (arg.startsWith("--node-win-x64=")) {
      options.nodeWinX64 = arg.slice("--node-win-x64=".length)
      continue
    }
    if (arg === "--keep-stage") {
      options.keepStage = true
      continue
    }
    throw new Error(`Unexpected argument for runner-only bundle: ${arg}`)
  }
  return options
}

function readValue(args: string[], index: number, flag: string) {
  const value = args[index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  return value
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

async function copyWindowsHarness(repoRoot: string, bundleRoot: string) {
  const source = join(repoRoot, "test", "ui-windows", "windows")
  await copyDirectoryContents(source, bundleRoot)
}

async function buildAndCopyRunner(repoRoot: string, bundleRoot: string) {
  const runnerRoot = join(repoRoot, "test", "ui-windows", "runner")
  const outDir = mkdtempSync(join(tmpdir(), "chipmate-ui-windows-runner-"))
  try {
    run(localTsc(repoRoot), ["--project", join(runnerRoot, "tsconfig.json"), "--outDir", outDir, "--rootDir", runnerRoot], repoRoot)
    await mkdir(join(bundleRoot, "runner"), { recursive: true })
    await copyDirectoryContents(outDir, join(bundleRoot, "runner"))
    await cp(join(runnerRoot, "package.json"), join(bundleRoot, "runner", "package.json"))
    const runnerNodeModules = join(runnerRoot, "node_modules")
    const targetNodeModules = join(bundleRoot, "runner", "node_modules")
    await mkdir(targetNodeModules, { recursive: true })
    if (existsSync(runnerNodeModules)) {
      await copyDirectoryContents(runnerNodeModules, targetNodeModules)
    } else {
      await writeFile(
        join(targetNodeModules, "README-OFFLINE-DEPENDENCIES.txt"),
        "The default runner-only harness has no npm runtime dependencies. Do not run npm install on the target Windows host.\n",
      )
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

async function copyFixtures(repoRoot: string, bundleRoot: string) {
  await cp(join(repoRoot, "test", "ui-windows", "fixtures"), join(bundleRoot, "fixtures"), {
    recursive: true,
    force: true,
    errorOnExist: false,
  })
}

async function copyNodeRuntime(nodeWinX64: string, bundleRoot: string) {
  const source = resolve(nodeWinX64)
  if (!existsSync(join(source, "node.exe"))) throw new Error(`--node-win-x64 must point to a directory containing node.exe: ${source}`)
  const target = join(bundleRoot, "bin", "node-win-x64")
  rmSync(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await copyDirectoryContents(source, target)
}

async function copyOptionalVscode(includeVscode: string | undefined, bundleRoot: string) {
  if (!includeVscode) return
  const source = resolve(includeVscode)
  if (!existsSync(source)) throw new Error(`--include-vscode path does not exist: ${source}`)
  await mkdir(join(bundleRoot, "vscode"), { recursive: true })
  const target = join(bundleRoot, "vscode", basename(source))
  await cp(source, target, { recursive: true, force: true, errorOnExist: false })
}

async function writeRunnerMetadata(bundleRoot: string, bundleName: string, includesVscode: boolean) {
  await writeFile(join(bundleRoot, "latest.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    name: bundleName,
    runnerBundle: true,
    target: "windows-offline-real-vscode",
    installMode: "already-installed",
    profileMode: "direct-real",
    extensionId: "local.chipmate",
    containsVsix: false,
    includesPortableNode: true,
    includesVscode,
  }, null, 2)}\n`)
}

async function copyDirectoryContents(source: string, target: string) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source)) {
    await cp(join(source, entry), join(target, entry), {
      recursive: true,
      force: true,
      errorOnExist: false,
    })
  }
}

async function assertNoBundledSecrets(bundleRoot: string) {
  const offenders: string[] = []
  await scan(bundleRoot)
  if (offenders.length) {
    throw new Error(`Potential secret leaked into Windows UI runner bundle:\n${offenders.join("\n")}`)
  }

  async function scan(path: string) {
    const info = await stat(path)
    if (info.isDirectory()) {
      if (["node_modules", "cache", "drivers", "bin", "vscode"].includes(basename(path))) return
      for (const entry of await readdir(path)) await scan(join(path, entry))
      return
    }
    if (!/\.(?:json|md|ps1|ts|js|txt|c|h|code-workspace)$/i.test(path)) return
    const text = readFileSync(path, "utf8")
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) offenders.push(path)
    }
  }
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`)
}

function localTsc(repoRoot: string) {
  return process.platform === "win32"
    ? join(repoRoot, "node_modules", ".bin", "tsc.cmd")
    : join(repoRoot, "node_modules", ".bin", "tsc")
}

function bundleStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("")
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
})
