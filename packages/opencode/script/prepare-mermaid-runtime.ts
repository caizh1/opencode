#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

const MERMAID_CLI_VERSION = "11.9.0"
const PUPPETEER_VERSION = "23.11.1"
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const tar = process.platform === "win32" ? "tar.exe" : "tar"
const stamp = `mermaid-cli@${MERMAID_CLI_VERSION}\npuppeteer@${PUPPETEER_VERSION}\nlinux-x64-glibc\nusr-local-bin-mmdc-v1\n`

export async function prepareMermaidRuntime(root = dir) {
  if (process.env.OPENCODE_MERMAID_RUNTIME_TGZ) {
    const provided = path.resolve(process.env.OPENCODE_MERMAID_RUNTIME_TGZ)
    await requireFile(provided)
    return provided
  }

  const cache = path.join(root, "dist-linux", ".cache", "mermaid-cli-linux-x64")
  const archive = path.join(root, "dist-linux", "mermaid-cli-linux-x64.tar.gz")
  if ((await readText(path.join(cache, ".stamp"))) === stamp && (await fileExists(archive))) {
    if (await findChrome(cache)) return archive
    await extractChromeZip(cache)
    if (await findChrome(cache)) {
      await writeMmdcShim(cache)
      await writeArchive(cache, archive, root)
      return archive
    }
  }

  await extractChromeZip(cache)
  if ((await hasMermaidCli(cache)) && (await findChrome(cache))) {
    await writeMmdcShim(cache)
    await Bun.write(path.join(cache, ".stamp"), stamp)
    await writeArchive(cache, archive, root)
    return archive
  }

  await fs.rm(cache, { recursive: true, force: true })
  await fs.mkdir(cache, { recursive: true })
  await Bun.write(
    path.join(cache, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@mermaid-js/mermaid-cli": MERMAID_CLI_VERSION,
          puppeteer: PUPPETEER_VERSION,
        },
      },
      null,
      2,
    ),
  )

  await run([npm, "install", "--omit=dev", "--ignore-scripts"], cache, {
    PUPPETEER_SKIP_DOWNLOAD: "true",
  })
  await run(
    [
      npm,
      "exec",
      "--",
      "puppeteer",
      "browsers",
      "install",
      "chrome-headless-shell@stable",
      "--platform=linux",
      `--path=${path.join(cache, "browsers")}`,
    ],
    cache,
  )
  await extractChromeZip(cache)
  if (!(await findChrome(cache))) throw new Error(`Could not find Linux chrome-headless-shell in ${cache}`)

  await writeMmdcShim(cache)
  await Bun.write(path.join(cache, ".stamp"), stamp)
  await writeArchive(cache, archive, root)
  return archive
}

export async function writeMmdcShim(root: string) {
  const file = path.join(root, "mmdc")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, mmdcShimContent())
  await fs.chmod(file, 0o755)
  return file
}

export function mmdcShimContent() {
  return `#!/usr/bin/env sh
set -eu

script="$0"
while [ -h "$script" ]; do
  dir="$(cd -P "$(dirname "$script")" >/dev/null 2>&1 && pwd)"
  link="$(readlink "$script")"
  case "$link" in
    /*) script="$link" ;;
    *) script="$dir/$link" ;;
  esac
done

bin_dir="$(cd -P "$(dirname "$script")" >/dev/null 2>&1 && pwd)"
runtime_dir="$bin_dir/mermaid-cli"
mmdc="$runtime_dir/node_modules/.bin/mmdc"
config="$runtime_dir/puppeteer-config.json"

command -v node >/dev/null 2>&1 || {
  echo "mmdc requires node in PATH; install Node ^18.19 or >=20.0 in the image." >&2
  exit 127
}

if [ ! -f "$config" ]; then
  chrome="$(find "$runtime_dir" -type f \\( -name chrome-headless-shell -o -name chrome \\) | head -n 1)"
  if [ -n "$chrome" ]; then
    if (umask 077 && printf '{\\n  "executablePath": "%s",\\n  "args": ["--no-sandbox", "--disable-setuid-sandbox"]\\n}\\n' "$chrome" > "$config") 2>/dev/null; then
      :
    else
      config="\${TMPDIR:-/tmp}/opencode-mermaid-puppeteer-config.json"
      umask 077 && printf '{\\n  "executablePath": "%s",\\n  "args": ["--no-sandbox", "--disable-setuid-sandbox"]\\n}\\n' "$chrome" > "$config"
    fi
  fi
fi

has_config=0
for arg in "$@"; do
  case "$arg" in
    -p|--puppeteerConfigFile|--puppeteerConfigFile=*) has_config=1 ;;
  esac
done

export PUPPETEER_CACHE_DIR="$runtime_dir/browsers"
if [ "$has_config" -eq 0 ] && [ -f "$config" ]; then
  exec "$mmdc" "$@" --puppeteerConfigFile "$config"
fi

exec "$mmdc" "$@"
`
}

async function writeArchive(cache: string, archive: string, root: string) {
  const release = path.join(root, "dist-linux", ".cache", "mermaid-cli-linux-x64-release")
  const runtime = path.join(release, "mermaid-cli")
  await fs.rm(release, { recursive: true, force: true })
  await fs.mkdir(runtime, { recursive: true })
  await Promise.all(
    ["node_modules", "browsers", "package.json", "package-lock.json", ".stamp"]
      .map((item) => copyIfExists(path.join(cache, item), path.join(runtime, item))),
  )
  await chmodIfExists(path.join(runtime, "node_modules", ".bin", "mmdc"), 0o755)
  const chrome = await findChrome(path.join(runtime, "browsers"))
  if (chrome) await chmodIfExists(chrome, 0o755)
  await writeMmdcShim(release)
  await fs.rm(archive, { force: true })
  await run([tar, "-czf", archive, "-C", release, "."], root)
}

async function copyIfExists(source: string, target: string) {
  if (!(await exists(source))) return
  await fs.cp(source, target, { recursive: true })
}

async function chmodIfExists(file: string, mode: number) {
  if (!(await exists(file))) return
  await fs.chmod(file, mode)
}

async function extractChromeZip(cache: string) {
  const zip = await findFile(path.join(cache, "browsers"), (file) =>
    path.basename(file).endsWith("-chrome-headless-shell-linux64.zip"),
  )
  if (!zip) return

  const version = path.basename(zip).replace(/-chrome-headless-shell-linux64\.zip$/, "")
  const target = path.join(path.dirname(zip), `linux-${version}`)
  if (await findChrome(target)) return
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })
  await run([tar, "-xf", zip, "-C", target], cache)
}

async function findChrome(root: string) {
  return findFile(root, (file) => path.basename(file) === "chrome-headless-shell" || path.basename(file) === "chrome")
}

async function hasMermaidCli(root: string) {
  return fileExists(path.join(root, "node_modules", "@mermaid-js", "mermaid-cli", "src", "cli.js"))
}

async function findFile(root: string, predicate: (file: string) => boolean): Promise<string | undefined> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const file = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(root, entry.name))
    .find(predicate)
  if (file) return file
  for (const dir of entries.filter((entry) => entry.isDirectory())) {
    const found = await findFile(path.join(root, dir.name), predicate)
    if (found) return found
  }
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code === 0) return
  throw new Error(`Command failed with code ${code}: ${cmd.join(" ")}`)
}

async function requireFile(file: string) {
  if (await fileExists(file)) return
  throw new Error(`Mermaid runtime archive not found: ${file}`)
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function fileExists(file: string) {
  return fs
    .stat(file)
    .then((stat) => stat.isFile())
    .catch(() => false)
}

async function readText(file: string) {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

if (import.meta.main) {
  console.log(await prepareMermaidRuntime())
}
