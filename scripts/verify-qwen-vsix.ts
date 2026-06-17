import { readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { spawnSync } from "node:child_process"

const requiredEntries = [
  "extension/node_modules/diff/package.json",
  "extension/node_modules/fastest-levenshtein/package.json",
  "extension/node_modules/ignore/package.json",
  "extension/node_modules/js-tiktoken/package.json",
  "extension/node_modules/web-tree-sitter/package.json",
  "extension/node_modules/web-tree-sitter/tree-sitter.wasm",
  "extension/vendor/qwen-autocomplete/tree-sitter/import-queries/typescript.scm",
  "extension/vendor/qwen-autocomplete/tree-sitter/root-path-context-queries/typescript/function_declaration.scm",
  "extension/vendor/tree-sitter/wasm/tree-sitter-typescript.wasm",
  "extension/vendor/tree-sitter/wasm/tree-sitter-cpp.wasm",
]

const vsix = process.argv[2] ?? latestVsix()
if (!vsix) {
  console.error("No chipmate-*.vsix file found. Pass a VSIX path or run bun run vsix first.")
  process.exit(1)
}

const listing = spawnSync("unzip", ["-Z1", vsix], { encoding: "utf8" })
if (listing.status !== 0) {
  console.error(listing.stderr || listing.stdout || `Failed to inspect ${vsix}`)
  process.exit(listing.status ?? 1)
}

const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean))
const missing = requiredEntries.filter((entry) => !entries.has(entry))
if (missing.length > 0) {
  console.error(`Qwen VSIX verification failed for ${basename(vsix)}. Missing entries:\n${missing.join("\n")}`)
  process.exit(1)
}

console.log(`Verified qwen autocomplete runtime dependencies and tree-sitter assets in ${basename(vsix)}.`)

function latestVsix(): string | undefined {
  const files = readdirSync(process.cwd())
    .filter((file) => /^chipmate-.*\.vsix$/.test(file))
    .sort()
  const file = files.at(-1)
  return file ? join(process.cwd(), file) : undefined
}
