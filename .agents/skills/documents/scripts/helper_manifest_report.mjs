import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const artifactDir = process.env.CHIPMATE_SKILL_ARTIFACT_DIR

if (!artifactDir) {
  console.error("CHIPMATE_SKILL_ARTIFACT_DIR is required.")
  process.exit(2)
}

const manifest = JSON.parse(await readFile(join(here, "manifest.json"), "utf8"))
const helpers = Array.isArray(manifest.helpers) ? manifest.helpers : []
const statusCounts = helpers.reduce((counts, helper) => {
  const status = typeof helper.status === "string" ? helper.status : "unknown"
  counts[status] = (counts[status] ?? 0) + 1
  return counts
}, {})
const directHelpers = helpers
  .filter((helper) => helper?.execution?.directExecution === true || helper?.directExecution === true)
  .map((helper) => ({
    name: helper.name ?? helper.codexScript ?? helper.script ?? helper.execution?.entrypoint,
    status: helper.status,
    category: helper.category,
    entrypoint: helper.execution?.entrypoint,
    runtime: helper.execution?.runtime,
    networkPolicy: helper.execution?.networkPolicy,
  }))

const report = {
  schemaVersion: manifest.schemaVersion,
  version: manifest.version,
  executionPolicy: {
    directExecution: manifest.executionPolicy?.directExecution === true,
    networkPolicy: manifest.executionPolicy?.networkPolicy ?? "none",
  },
  helperCount: helpers.length,
  statusCounts,
  directHelpers,
}

await mkdir(artifactDir, { recursive: true })
const reportPath = join(artifactDir, "helper-manifest-report.json")
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

console.log(JSON.stringify({
  ok: true,
  helperCount: report.helperCount,
  directHelperCount: directHelpers.length,
  artifact: "helper-manifest-report.json",
}))
