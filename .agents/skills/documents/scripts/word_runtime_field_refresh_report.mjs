import { mkdir, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

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
  nativeFieldRefresh: {
    available: false,
    reason: "Remote native field refresh is not implemented, and the VSIX client does not run local LibreOffice/soffice.",
  },
  directHelperScope: {
    readOnly: true,
    writesOnlyArtifact: "word-runtime-field-refresh-report.json",
    recommendedAction: "Use static TOC/page text, update fields manually in Word, or wait for a remote field-refresh provider.",
  },
}

await mkdir(artifactDir, { recursive: true })
const reportPath = join(artifactDir, "word-runtime-field-refresh-report.json")
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

console.log(JSON.stringify({
  ok: true,
  nativeFieldRefreshAvailable: report.nativeFieldRefresh.available,
  artifact: "word-runtime-field-refresh-report.json",
}))
