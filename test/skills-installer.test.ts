import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip = require("jszip")
import { ChipMatePackageInstaller } from "../src/skills-installer"
import type { ChipMateCatalogPackage } from "../src/skills-catalog"

describe("ChipMatePackageInstaller", () => {
  test("installs a skill zip with SKILL.md and lists it as an installed skill", async () => {
    await withRoot(async (root) => {
      const installer = new ChipMatePackageInstaller(root)
      const pkg = catalogPackage({ version: "1.0.0" })
      const bytes = await zipBytes({
        "embedded-review/SKILL.md": "---\nname: Embedded Review\ndescription: Review firmware patches\n---\nUse care.",
        "embedded-review/references/checklist.md": "Checklist",
      })

      const result = await installer.installZip({ catalogUrl: "http://offline/catalog.json", pkg, bytes, now: new Date("2026-06-10T00:00:00Z") })
      const installed = await installer.installedSkills()

      expect(result.installed).toMatchObject({
        id: "embedded-review",
        type: "skill",
        version: "1.0.0",
        installedAt: "2026-06-10T00:00:00.000Z",
      })
      expect(installed).toEqual([{
        id: "embedded-review",
        root: join(root, "skills", "embedded-review"),
        version: "1.0.0",
        enabled: true,
      }])
      await expect(fs.readFile(join(root, "skills", "embedded-review", "references", "checklist.md"), "utf8")).resolves.toBe("Checklist")
    })
  })

  test("backs up the previous install and rolls it back", async () => {
    await withRoot(async (root) => {
      const installer = new ChipMatePackageInstaller(root)
      await installer.installZip({
        catalogUrl: "http://offline/catalog.json",
        pkg: catalogPackage({ version: "1.0.0" }),
        bytes: await zipBytes({ "SKILL.md": "---\nname: Old\n---\nOld instructions" }),
      })
      const upgraded = await installer.installZip({
        catalogUrl: "http://offline/catalog.json",
        pkg: catalogPackage({ version: "2.0.0" }),
        bytes: await zipBytes({ "SKILL.md": "---\nname: New\n---\nNew instructions" }),
      })

      expect(upgraded.previousVersion).toBe("1.0.0")
      await expect(fs.readFile(join(root, "skills", "embedded-review", "SKILL.md"), "utf8")).resolves.toContain("New instructions")

      const rolledBack = await installer.rollback({ type: "skill", id: "embedded-review" })

      expect(rolledBack.version).toBe("1.0.0")
      await expect(fs.readFile(join(root, "skills", "embedded-review", "SKILL.md"), "utf8")).resolves.toContain("Old instructions")
    })
  })

  test("rejects unsafe zip paths", async () => {
    await withRoot(async (root) => {
      const installer = new ChipMatePackageInstaller(root)
      const zip = new JSZip()
      zip.file("../escape.txt", "bad")
      const bytes = await zip.generateAsync({ type: "uint8array" })

      await expect(installer.installZip({
        catalogUrl: "http://offline/catalog.json",
        pkg: catalogPackage(),
        bytes,
      })).rejects.toThrow("unsafe path")
    })
  })

  test("extracts deflated zip packages without runtime node_modules dependencies", async () => {
    await withRoot(async (root) => {
      const installer = new ChipMatePackageInstaller(root)
      const bytes = await zipBytes({
        "SKILL.md": "---\nname: Deflated\n---\nDeflated skill instructions",
      }, "DEFLATE")

      await installer.installZip({
        catalogUrl: "http://offline/catalog.json",
        pkg: catalogPackage(),
        bytes,
      })

      await expect(fs.readFile(join(root, "skills", "embedded-review", "SKILL.md"), "utf8")).resolves.toContain("Deflated skill")
    })
  })
})

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), "chipmate-installer-"))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function zipBytes(files: Record<string, string>, compression?: "STORE" | "DEFLATE") {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) zip.file(path, content)
  return zip.generateAsync({ type: "uint8array", compression })
}

function catalogPackage(overrides: Partial<ChipMateCatalogPackage> = {}): ChipMateCatalogPackage {
  return {
    id: "embedded-review",
    type: "skill",
    name: "Embedded Review",
    version: "1.0.0",
    description: "Review firmware patches",
    downloadUrl: "skills/embedded-review.zip",
    sha256: "a".repeat(64),
    dependencies: [],
    ...overrides,
  }
}
