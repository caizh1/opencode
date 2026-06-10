import { afterEach, describe, expect, test } from "bun:test"
import * as http from "node:http"
import {
  downloadChipMateCatalogPackage,
  fetchChipMateCatalog,
  isSafePackageRelativePath,
  parseChipMateCatalog,
  resolveCatalogDownloadUrl,
  sha256Hex,
} from "../src/skills-catalog"

let servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
  servers = []
})

describe("ChipMate skills catalog", () => {
  test("parses catalog packages and optional dependencies", () => {
    const catalog = parseChipMateCatalog({
      schemaVersion: 1,
      updatedAt: "2026-06-10T00:00:00Z",
      packages: [{
        id: "embedded-c-review",
        type: "skill",
        name: "Embedded C Review",
        version: "1.0.0",
        description: "Review embedded C changes.",
        downloadUrl: "skills/embedded-c-review.zip",
        sha256: "a".repeat(64),
        permissions: { runsScripts: true },
        dependencies: [{ id: "code-search", type: "mcp", version: ">=0.1.0", required: false }],
      }],
    })

    expect(catalog.packages[0]).toMatchObject({
      id: "embedded-c-review",
      type: "skill",
      dependencies: [{ id: "code-search", type: "mcp", version: ">=0.1.0", required: false }],
    })
  })

  test("rejects invalid schema and duplicate package versions", () => {
    expect(() => parseChipMateCatalog({ schemaVersion: 2, packages: [] })).toThrow("schemaVersion")
    expect(() => parseChipMateCatalog({
      schemaVersion: 1,
      packages: [
        pkg({ id: "same" }),
        pkg({ id: "same" }),
      ],
    })).toThrow("duplicate")
    expect(() => parseChipMateCatalog({
      schemaVersion: 1,
      packages: [pkg({ sha256: "bad" })],
    })).toThrow("sha256")
  })

  test("resolves relative package download URLs from the catalog URL", () => {
    expect(resolveCatalogDownloadUrl("http://host/assets/catalog.json", "skills/a.zip")).toBe("http://host/assets/skills/a.zip")
    expect(resolveCatalogDownloadUrl("http://host/assets/catalog.json", "http://mirror/a.zip")).toBe("http://mirror/a.zip")
  })

  test("fetches catalogs and downloads packages with sha256 verification", async () => {
    const bytes = new TextEncoder().encode("package bytes")
    const digest = sha256Hex(bytes)
    const baseUrl = await listen((request, response) => {
      if (request.url === "/catalog.json") {
        json(response, 200, {
          schemaVersion: 1,
          packages: [pkg({ sha256: digest, sizeBytes: bytes.byteLength, downloadUrl: "skills/pkg.zip" })],
        })
        return
      }
      if (request.url === "/skills/pkg.zip") {
        response.writeHead(200, { "content-type": "application/zip" })
        response.end(bytes)
        return
      }
      response.writeHead(404).end()
    })

    const catalogUrl = `${baseUrl}/catalog.json`
    const catalog = await fetchChipMateCatalog(catalogUrl)
    const downloaded = await downloadChipMateCatalogPackage({ catalogUrl, pkg: catalog.packages[0]! })

    expect(new TextDecoder().decode(downloaded)).toBe("package bytes")
  })

  test("rejects package sha mismatches and unsafe archive paths", async () => {
    const bytes = new TextEncoder().encode("package bytes")
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/zip" })
      response.end(bytes)
    })

    await expect(downloadChipMateCatalogPackage({
      catalogUrl: `${baseUrl}/catalog.json`,
      pkg: pkg({ sha256: "b".repeat(64), sizeBytes: bytes.byteLength, downloadUrl: "pkg.zip" }),
    })).rejects.toThrow("sha256 mismatch")

    expect(isSafePackageRelativePath("skills/SKILL.md")).toBe(true)
    expect(isSafePackageRelativePath("../outside")).toBe(false)
    expect(isSafePackageRelativePath("/absolute")).toBe(false)
    expect(isSafePackageRelativePath("C:\\absolute\\path")).toBe(false)
  })
})

function pkg(overrides: Record<string, unknown> = {}) {
  return {
    id: "embedded-c-review",
    type: "skill",
    name: "Embedded C Review",
    version: "1.0.0",
    description: "Review embedded C changes.",
    downloadUrl: "skills/embedded-c-review.zip",
    sha256: "a".repeat(64),
    ...overrides,
  }
}

function listen(handler: http.RequestListener) {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("server did not bind a TCP port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function json(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}
