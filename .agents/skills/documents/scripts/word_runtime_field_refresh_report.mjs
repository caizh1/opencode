import { access, mkdir, stat, writeFile } from "node:fs/promises"
import { dirname, delimiter, join, resolve, sep } from "node:path"

const artifactDir = process.env.CHIPMATE_SKILL_ARTIFACT_DIR
const workspaceRoot = process.env.CHIPMATE_WORKSPACE_ROOT
const networkPolicy = process.env.CHIPMATE_NETWORK_POLICY ?? "none"

if (!artifactDir) {
  console.error("CHIPMATE_SKILL_ARTIFACT_DIR is required.")
  process.exit(2)
}

let stdin = ""
for await (const chunk of process.stdin) stdin += chunk
const args = JSON.parse(stdin || "{}")
const documentPath = typeof args.documentPath === "string" && args.documentPath.trim() ? args.documentPath.trim() : undefined

const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
const candidates = [
  process.env.CHIPMATE_SOFFICE_PATH,
  ...pathEntries.map((entry) => join(entry, "soffice")),
  ...pathEntries.map((entry) => join(entry, "libreoffice")),
].filter(Boolean)

const existing = []
for (const candidate of candidates) {
  try {
    await access(candidate)
    if (!existing.includes(candidate)) existing.push(candidate)
  } catch {
    // Read-only diagnostic: unavailable candidates are reported through existing list.
  }
}

let document = undefined
if (documentPath && workspaceRoot) {
  const absolute = resolve(workspaceRoot, documentPath)
  const rootWithSep = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
  const inWorkspace = absolute === workspaceRoot || absolute.startsWith(rootWithSep)
  const item = inWorkspace ? await stat(absolute).catch(() => undefined) : undefined
  document = {
    path: documentPath,
    inWorkspace,
    exists: Boolean(item?.isFile()),
    bytes: item?.isFile() ? item.size : 0,
  }
}

const report = {
  ok: true,
  networkPolicy,
  workspaceRootPresent: Boolean(workspaceRoot),
  document,
  libreOffice: {
    available: existing.length > 0,
    candidatesChecked: candidates.length,
    firstExecutable: existing[0],
  },
  directHelperScope: {
    readOnly: true,
    writesOnlyArtifact: "word-runtime-field-refresh-report.json",
    nativeToolToUseForRefresh: "refresh_word_native_fields",
  },
}

await mkdir(artifactDir, { recursive: true })
const reportPath = join(artifactDir, "word-runtime-field-refresh-report.json")
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

console.log(JSON.stringify({
  ok: true,
  libreOfficeAvailable: report.libreOffice.available,
  artifact: "word-runtime-field-refresh-report.json",
}))
