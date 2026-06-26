import { spawnSync } from "node:child_process"

type VerifyOptions = {
  bundle?: string
  strict?: boolean
}

const REQUIRED_ENTRIES = [
  "latest.json",
  "README-WINDOWS-OFFLINE-UI-TEST.md",
  "test-config.example.json",
  "run-chipmate-ui-smoke.ps1",
  "run-chipmate-ui-full.ps1",
  "collect-chipmate-ui-report.ps1",
  "bin/node-win-x64/node.exe",
  "runner/main.js",
  "runner/package.json",
  "runner/node_modules/",
  "runner/drivers/",
  "runner/cache/",
  "fixtures/workspaces/smoke/",
  "fixtures/workspaces/full/",
  "fixtures/documents/",
  "fixtures/comments/",
  "fixtures/completion/",
  "scripts/collect-vscode-state.ps1",
  "scripts/redact-report.ps1",
] as const

const FORBIDDEN_ENTRIES = [
  /^chipmate-.*\.vsix$/i,
  /^SHA256SUMS\.txt$/i,
  /^scripts\/install-vsix\.ps1$/i,
  /^scripts\/clone-vscode-profile\.ps1$/i,
] as const

const SECRET_PATTERNS = [
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/i,
  /"apiKey"\s*:\s*"(?!\s*"|\[REDACTED\]|<)[^"]{8,}"/i,
  /(?:^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{12,}/i,
]

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.bundle) throw new Error("Usage: bun scripts/verify-windows-ui-test-bundle.ts --bundle <chipmate-ui-runner-windows.zip> [--strict]")
  const bundle = options.bundle
  const entries = zipEntries(bundle)
  const root = commonRoot(entries)
  const normalized = entries.map((entry) => entry.slice(root.length))
  const missing = REQUIRED_ENTRIES.filter((required) => !hasEntry(normalized, required))
  const forbidden = normalized.filter((entry) => FORBIDDEN_ENTRIES.some((pattern) => pattern.test(entry)))

  const latest = JSON.parse(readZipText(bundle, `${root}latest.json`)) as {
    runnerBundle?: boolean
    containsVsix?: boolean
    installMode?: string
    profileMode?: string
    extensionId?: string
    includesPortableNode?: boolean
  }
  if (latest.runnerBundle !== true) missing.push("latest.json runnerBundle=true")
  if (latest.containsVsix !== false) missing.push("latest.json containsVsix=false")
  if (latest.installMode !== "already-installed") missing.push("latest.json installMode=already-installed")
  if (latest.profileMode !== "direct-real") missing.push("latest.json profileMode=direct-real")
  if (latest.extensionId !== "local.chipmate") missing.push("latest.json extensionId=local.chipmate")
  if (latest.includesPortableNode !== true) missing.push("latest.json includesPortableNode=true")

  const secretHits = scanZipTextEntries(bundle, entries)
  if (missing.length || forbidden.length || secretHits.length) {
    if (missing.length) console.error(`Windows UI runner bundle verification failed. Missing/invalid:\n${missing.join("\n")}`)
    if (forbidden.length) console.error(`Forbidden runner-only entries found:\n${forbidden.join("\n")}`)
    if (secretHits.length) console.error(`Potential secrets found:\n${secretHits.join("\n")}`)
    process.exit(1)
  }

  console.log(`Verified Windows runner-only UI test bundle: ${bundle}`)
}

function parseArgs(args: string[]): VerifyOptions {
  const options: VerifyOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--bundle") {
      options.bundle = readValue(args, ++index, arg)
      continue
    }
    if (arg.startsWith("--bundle=")) {
      options.bundle = arg.slice("--bundle=".length)
      continue
    }
    if (arg === "--strict") {
      options.strict = true
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }
  return options
}

function readValue(args: string[], index: number, flag: string) {
  const value = args[index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  return value
}

function zipEntries(bundle: string) {
  const result = spawnSync("unzip", ["-Z1", bundle], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Failed to list ${bundle}`)
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

function commonRoot(entries: string[]) {
  const first = entries[0]
  const slash = first?.indexOf("/") ?? -1
  if (slash < 0) throw new Error("Bundle entries are not rooted under one directory")
  return first.slice(0, slash + 1)
}

function hasEntry(entries: string[], required: string) {
  return entries.some((entry) => entry === required || entry.startsWith(required))
}

function readZipText(bundle: string, entry: string) {
  const result = spawnSync("unzip", ["-p", bundle, entry], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Failed to read ${entry}`)
  return result.stdout
}

function scanZipTextEntries(bundle: string, entries: string[]) {
  const hits: string[] = []
  for (const entry of entries) {
    if (/\/(?:node_modules|cache|drivers|bin|vscode)\//.test(entry)) continue
    if (!/\.(?:json|md|ps1|js|txt|c|h|code-workspace)$/i.test(entry)) continue
    const text = readZipText(bundle, entry)
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) hits.push(entry)
    }
  }
  return hits
}

main()
