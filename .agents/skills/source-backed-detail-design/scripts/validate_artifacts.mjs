import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

const REQUIRED_REFERENCES = [
  "references/01-core-principles.md",
  "references/02-input-and-module-scope-rules.md",
  "references/03-source-exploration-rules.md",
  "references/04-control-flow-evidence-schema.md",
  "references/05-submodule-business-flow-rules.md",
  "references/06-state-machine-extraction-rules.md",
  "references/07-diagram-planning-and-splitting-rules.md",
  "references/08-mermaid-png-rendering-rules.md",
  "references/09-parent-module-assembly-rules.md",
  "references/10-detail-design-output-templates.md",
  "references/11-feature-diff-completeness-rules.md",
  "references/12-word-export-rules.md",
  "references/13-quality-gates-and-validator.md",
  "references/14-continuation-checkpoint-protocol.md",
  "references/15-business-flow-abstraction-rules.md",
]

const REQUIRED_FINAL_FILES = [
  "02-source-evidence/module-scope.md",
  "02-source-evidence/source-evidence-index.md",
  "03-control-flow-evidence/01-function-inventory.csv",
  "03-control-flow-evidence/02-entry-points.csv",
  "03-control-flow-evidence/03-call-edges.csv",
  "03-control-flow-evidence/04-function-branches.csv",
  "03-control-flow-evidence/05-state-transitions.csv",
  "03-control-flow-evidence/09-business-capability-map.csv",
  "03-control-flow-evidence/10-business-flow-steps.csv",
  "03-control-flow-evidence/11-business-flow-edges.csv",
  "03-control-flow-evidence/12-business-flow-edge-coverage.csv",
  "03-control-flow-evidence/13-business-text-coverage.csv",
  "04-diagrams/diagram-index.md",
  "04-diagrams/business-flow-index.md",
  "05-enhanced-detail-design/README.md",
  "07-diff-and-improvement-report.md",
  "08-word-export-input.md",
  "resume-state.md",
  "continue-prompt.md",
  "quality-gate-report.md",
]

const CSV_FILES = new Set(REQUIRED_FINAL_FILES.filter((file) => file.endsWith(".csv")))

const input = await readJsonStdin()
const workspaceRoot = process.env.CHIPMATE_WORKSPACE_ROOT || process.cwd()
const skillRoot = process.env.CHIPMATE_SKILL_ROOT || process.cwd()
const artifactRoot = process.env.CHIPMATE_SKILL_ARTIFACT_DIR || process.cwd()
const mode = input.mode === "current" ? "current" : "final"
const outputRoot = resolveInside(workspaceRoot, stringValue(input.outputRoot || ""))
const wordPath = input.wordPath ? resolveInside(workspaceRoot, stringValue(input.wordPath)) : undefined
const issues = []
const checks = []

await checkSkillReferences()
await checkOutputRoot()
await checkFinalArtifacts()
await checkDiagramPairs()
await checkWordOutput()

const errors = issues.filter((issue) => issue.severity === "error").length
const warnings = issues.filter((issue) => issue.severity === "warning").length
const report = {
  ok: errors === 0,
  status: errors === 0 ? "PASS" : "INCOMPLETE",
  mode,
  checkedAt: new Date().toISOString(),
  outputRoot: path.relative(workspaceRoot, outputRoot) || ".",
  wordPath: wordPath ? path.relative(workspaceRoot, wordPath) : undefined,
  summary: {
    checks: checks.length,
    errors,
    warnings,
  },
  checks,
  issues,
}

await fsp.mkdir(artifactRoot, { recursive: true })
await fsp.writeFile(path.join(artifactRoot, "validate-artifacts-report.json"), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  ok: report.ok,
  status: report.status,
  mode: report.mode,
  outputRoot: report.outputRoot,
  errors,
  warnings,
}, null, 2))
process.exit(report.ok ? 0 : 1)

async function checkSkillReferences() {
  for (const relative of REQUIRED_REFERENCES) {
    const absolute = path.join(skillRoot, ...relative.split("/"))
    const exists = await fileExists(absolute)
    checks.push({ name: "skill-reference", path: relative, ok: exists })
    if (!exists) addIssue("error", "missing-skill-reference", `Required skill reference is missing: ${relative}`, relative)
  }
}

async function checkOutputRoot() {
  const exists = await dirExists(outputRoot)
  checks.push({ name: "output-root", path: rel(outputRoot), ok: exists })
  if (!exists) addIssue("error", "missing-output-root", `Output root does not exist: ${rel(outputRoot)}`, rel(outputRoot))
}

async function checkFinalArtifacts() {
  if (mode !== "final") return
  for (const relative of REQUIRED_FINAL_FILES) {
    const absolute = path.join(outputRoot, ...relative.split("/"))
    const exists = await fileExists(absolute)
    const nonEmpty = exists ? (await fsp.stat(absolute)).size > 0 : false
    const csvHasRows = exists && CSV_FILES.has(relative) ? await csvHasDataRows(absolute) : true
    checks.push({ name: "required-final-file", path: relative, ok: exists && nonEmpty && csvHasRows })
    if (!exists) addIssue("error", "missing-required-artifact", `Required final artifact is missing: ${relative}`, relative)
    else if (!nonEmpty) addIssue("error", "empty-required-artifact", `Required final artifact is empty: ${relative}`, relative)
    else if (!csvHasRows) addIssue("error", "csv-has-only-header", `Required CSV has no data rows: ${relative}`, relative)
  }
}

async function checkDiagramPairs() {
  const mmdRoot = path.join(outputRoot, "04-diagrams", "mmd")
  const pngRoot = path.join(outputRoot, "04-diagrams", "png")
  const mmdFiles = await listFiles(mmdRoot, ".mmd")
  const pngFiles = await listFiles(pngRoot, ".png")
  checks.push({ name: "diagram-mmd-count", path: "04-diagrams/mmd", ok: mode === "current" || mmdFiles.length > 0, count: mmdFiles.length })
  checks.push({ name: "diagram-png-count", path: "04-diagrams/png", ok: mode === "current" || pngFiles.length > 0, count: pngFiles.length })
  if (mode === "final" && mmdFiles.length === 0) addIssue("error", "missing-mermaid-sources", "No Mermaid .mmd files were found under 04-diagrams/mmd.", "04-diagrams/mmd")
  if (mode === "final" && pngFiles.length === 0) addIssue("error", "missing-mermaid-pngs", "No Mermaid .png files were found under 04-diagrams/png.", "04-diagrams/png")

  const pngKeys = new Set(pngFiles.map((file) => diagramKey(pngRoot, file)))
  for (const file of mmdFiles) {
    const key = diagramKey(mmdRoot, file)
    if (pngKeys.has(key)) continue
    addIssue("error", "mmd-without-png", `Mermaid source has no paired PNG: ${path.relative(outputRoot, file)}`, path.relative(outputRoot, file))
  }
}

async function checkWordOutput() {
  if (mode !== "final") return
  const candidates = [
    ...(wordPath ? [wordPath] : []),
    ...(await listFiles(outputRoot, ".docx")),
  ]
  const existing = []
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      const size = (await fsp.stat(candidate)).size
      if (size > 0) existing.push({ path: candidate, size })
    }
  }
  checks.push({ name: "word-docx", path: wordPath ? rel(wordPath) : rel(outputRoot), ok: existing.length > 0, count: existing.length })
  if (existing.length === 0) addIssue("error", "missing-word-docx", "No non-empty Word .docx artifact was found. Pass wordPath if create_word_document wrote the document outside outputRoot.", wordPath ? rel(wordPath) : rel(outputRoot))
}

function addIssue(severity, code, message, issuePath) {
  issues.push({ severity, code, message, path: issuePath })
}

function diagramKey(root, file) {
  return path.relative(root, file).replace(/\\/g, "/").replace(/\.(mmd|png)$/i, "")
}

async function csvHasDataRows(file) {
  const text = await fsp.readFile(file, "utf8").catch(() => "")
  return text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).length > 1
}

async function listFiles(root, extension) {
  const result = []
  await walk(root, result, extension)
  return result
}

async function walk(root, result, extension) {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) await walk(absolute, result, extension)
    else if (entry.isFile() && absolute.toLowerCase().endsWith(extension)) result.push(absolute)
  }
}

async function readJsonStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8").trim()
  if (!text) return {}
  return JSON.parse(text)
}

function stringValue(value) {
  return typeof value === "string" ? value : ""
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath)
  const normalizedRoot = path.resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relativePath}`)
  }
  return target
}

function rel(file) {
  return path.relative(workspaceRoot, file) || "."
}

async function fileExists(file) {
  const stat = await fsp.stat(file).catch(() => undefined)
  return Boolean(stat?.isFile())
}

async function dirExists(file) {
  const stat = await fsp.stat(file).catch(() => undefined)
  return Boolean(stat?.isDirectory())
}
