import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"

const require = createRequire(import.meta.url)
const renderServer = require("../server/chipmate-word-render/server.js") as {
  compareExtensionVersions: (left: string, right: string) => number
  generatePackageManifest: (packageRoot: string, extensionId: string) => Promise<{
    ok: true
    schemaVersion: 1
    latest: { extensionId: string; version: string; filename: string; sha256: string; sizeBytes: number; url: string } | null
    packages: Array<{ extensionId: string; version: string; filename: string; sha256: string; sizeBytes: number; url: string }>
  }>
}

describe("render service package manifest", () => {
  test("orders build-number VSIX packages and filters other extension identities", async () => {
    const root = join(tmpdir(), `chipmate-render-packages-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(root, { recursive: true })
    try {
      await writeVsix(join(root, "chipmate-0.2.0-build.26.vsix"), { publisher: "local", name: "chipmate", version: "0.2.0-build.26" })
      await writeVsix(join(root, "chipmate-0.2.0-build.27.vsix"), { publisher: "local", name: "chipmate", version: "0.2.0-build.27" })
      await writeVsix(join(root, "other-9.9.9.vsix"), { publisher: "other", name: "chipmate", version: "9.9.9" })
      await writeFile(join(root, "README.txt"), "not a package")

      const manifest = await renderServer.generatePackageManifest(root, "local.chipmate")

      expect(manifest.ok).toBe(true)
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.latest?.version).toBe("0.2.0-build.27")
      expect(manifest.latest?.filename).toBe("chipmate-0.2.0-build.27.vsix")
      expect(manifest.latest?.url).toBe("/packages/chipmate-0.2.0-build.27.vsix")
      expect(manifest.latest?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.latest?.sizeBytes).toBeGreaterThan(0)
      expect(manifest.packages.map((entry) => entry.version)).toEqual(["0.2.0-build.27", "0.2.0-build.26"])
      expect(manifest.packages.every((entry) => entry.extensionId === "local.chipmate")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses the same prerelease ordering contract as the VS Code extension", () => {
    expect(renderServer.compareExtensionVersions("0.2.0-build.27", "0.2.0-build.26")).toBeGreaterThan(0)
    expect(renderServer.compareExtensionVersions("0.2.0", "0.2.0-build.999")).toBeGreaterThan(0)
    expect(renderServer.compareExtensionVersions("0.2.1-build.1", "0.2.0-build.999")).toBeGreaterThan(0)
  })
})

async function writeVsix(target: string, manifest: { publisher: string; name: string; version: string }) {
  const zip = new JSZip()
  zip.file("extension/package.json", JSON.stringify(manifest, null, 2))
  const bytes = await zip.generateAsync({ type: "uint8array" })
  await writeFile(target, bytes)
}
