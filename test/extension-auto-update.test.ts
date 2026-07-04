import { describe, expect, mock, test } from "bun:test"
import { join } from "node:path"

class UriShim {
  constructor(readonly fsPath: string) {}

  static file(path: string) {
    return new UriShim(path)
  }

  static joinPath(base: UriShim, ...segments: string[]) {
    return new UriShim(join(base.fsPath, ...segments))
  }
}

mock.module("vscode", () => ({
  Uri: UriShim,
  commands: {
    executeCommand: async () => undefined,
  },
  extensions: {
    getExtension: () => undefined,
  },
  window: {
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T) => fallback as T,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    fs: {
      createDirectory: async () => undefined,
      writeFile: async () => undefined,
    },
  },
  Disposable: class Disposable {
    constructor(readonly callOnDispose: () => void) {}
    dispose() {
      this.callOnDispose()
    }
  },
}))

const autoUpdate = await import("../src/extension-auto-update")

describe("extension auto update", () => {
  test("derives the package manifest URL from render service endpoints", () => {
    expect(autoUpdate.deriveManifestUrl("", "http://render.example.test:6001")).toBe("http://render.example.test:6001/packages/manifest.json")
    expect(autoUpdate.deriveManifestUrl("", "http://render.example.test:6001/render/word")).toBe("http://render.example.test:6001/packages/manifest.json")
    expect(autoUpdate.deriveManifestUrl("https://updates.example.test/packages/manifest.json", "http://render.example.test:6001")).toBe("https://updates.example.test/packages/manifest.json")
    expect(autoUpdate.deriveManifestUrl("", "")).toBeUndefined()
    expect(autoUpdate.deriveManifestUrl("", "file:///tmp/render")).toBeUndefined()
  })

  test("validates a newer same-origin ChipMate package candidate", () => {
    const candidate = autoUpdate.validateUpdateManifest(manifestFixture("0.2.0-build.27"), {
      manifestUrl: "http://render.example.test:6001/packages/manifest.json",
      extensionId: "local.chipmate",
      runningVersion: "0.2.0-build.26",
    })

    expect(candidate.latest.version).toBe("0.2.0-build.27")
    expect(candidate.downloadUrl).toBe("http://render.example.test:6001/packages/chipmate-0.2.0-build.27.vsix")
  })

  test("rejects stale, mismatched, unsafe, and unsigned manifests", () => {
    expect(() => autoUpdate.validateUpdateManifest(manifestFixture("0.2.0-build.26"), {
      manifestUrl: "http://render.example.test:6001/packages/manifest.json",
      extensionId: "local.chipmate",
      runningVersion: "0.2.0-build.26",
    })).toThrow("not newer")

    expect(() => autoUpdate.validateUpdateManifest({
      ...manifestFixture("0.2.0-build.27"),
      latest: { ...manifestFixture("0.2.0-build.27").latest, extensionId: "other.chipmate" },
    }, {
      manifestUrl: "http://render.example.test:6001/packages/manifest.json",
      extensionId: "local.chipmate",
      runningVersion: "0.2.0-build.26",
    })).toThrow("extensionId")

    expect(() => autoUpdate.validateUpdateManifest({
      ...manifestFixture("0.2.0-build.27"),
      latest: { ...manifestFixture("0.2.0-build.27").latest, url: "https://evil.example.test/chipmate.vsix" },
    }, {
      manifestUrl: "http://render.example.test:6001/packages/manifest.json",
      extensionId: "local.chipmate",
      runningVersion: "0.2.0-build.26",
    })).toThrow("manifest origin")

    expect(() => autoUpdate.validateUpdateManifest({
      ...manifestFixture("0.2.0-build.27"),
      latest: { ...manifestFixture("0.2.0-build.27").latest, sha256: "" },
    }, {
      manifestUrl: "http://render.example.test:6001/packages/manifest.json",
      extensionId: "local.chipmate",
      runningVersion: "0.2.0-build.26",
    })).toThrow("sha256")
  })

  test("suppresses only the declined version until the next prompt time", () => {
    expect(autoUpdate.shouldSuppressPrompt("0.2.0-build.27", "0.2.0-build.27", 2000, 1000)).toBe(true)
    expect(autoUpdate.shouldSuppressPrompt("0.2.0-build.28", "0.2.0-build.27", 2000, 1000)).toBe(false)
    expect(autoUpdate.shouldSuppressPrompt("0.2.0-build.27", "0.2.0-build.27", 1000, 2000)).toBe(false)
  })

  test("hashes downloaded VSIX bytes with sha256", () => {
    expect(autoUpdate.sha256Hex(new TextEncoder().encode("chipmate"))).toBe("02d616959992c961ab4f270af77b6046354628f9ebcf2798ac429527f1a75144")
  })
})

function manifestFixture(version: string) {
  return {
    ok: true,
    schemaVersion: 1,
    service: "chipmate-word-render",
    generatedAt: "2026-07-03T00:00:00.000Z",
    latest: {
      extensionId: "local.chipmate",
      publisher: "local",
      name: "chipmate",
      version,
      filename: `chipmate-${version}.vsix`,
      url: `/packages/chipmate-${version}.vsix`,
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      mtimeMs: 1780000000000,
    },
    packages: [],
  }
}
