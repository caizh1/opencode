import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { applyVsixLocalDefaults, collectVsixLocalDefaultSettings, parsePackageVsixCliArgs, resolvePackageVsixVersion } from "../scripts/package-vsix"

describe("package-vsix script", () => {
  test("creates the requested v0.1.0 build package version", () => {
    expect(resolvePackageVsixVersion({
      currentVersion: "0.0.245",
      release: "0.1.0",
      build: "1",
    })).toBe("0.1.0-build.1")
  })

  test("increments the current build number by default", () => {
    expect(resolvePackageVsixVersion({ currentVersion: "0.1.0-build.1" })).toBe("0.1.0-build.2")
  })

  test("starts a new release line at build 1 when release changes", () => {
    expect(resolvePackageVsixVersion({
      currentVersion: "0.1.0-build.9",
      release: "0.1.2",
    })).toBe("0.1.2-build.1")
  })

  test("rejects positional semantic bumps", () => {
    expect(() => parsePackageVsixCliArgs(["patch"])).toThrow("Semantic version bumps")
    expect(() => resolvePackageVsixVersion({
      currentVersion: "0.1.0-build.1",
      build: "0",
    })).toThrow("positive integer")
  })

  test("collects required local VSIX defaults without hardcoded production values", () => {
    expect(collectVsixLocalDefaultSettings(localDefaultsFixture())).toEqual({
      "chipmate.provider.apiBaseUrl": "https://provider.example.test/v1",
      "chipmate.provider.chatModel": "chat-model",
      "chipmate.rag.embedding.endpoint": "https://provider.example.test/v1/embeddings",
      "chipmate.rag.embedding.model": "embedding-model",
      "chipmate.rag.rerank.endpoint": "https://provider.example.test/v1/rerank",
      "chipmate.rag.rerank.model": "rerank-model",
      "chipmate.rag.allowedHosts": ["provider.example.test"],
    })
  })

  test("applies local VSIX defaults to manifest configuration defaults", () => {
    const manifest = manifestFixture()
    applyVsixLocalDefaults(manifest, localDefaultsFixture())

    const properties = manifest.contributes.configuration.properties
    expect(properties["chipmate.provider.apiBaseUrl"].default).toBe("https://provider.example.test/v1")
    expect(properties["chipmate.provider.chatModel"].default).toBe("chat-model")
    expect(properties["chipmate.rag.embedding.endpoint"].default).toBe("https://provider.example.test/v1/embeddings")
    expect(properties["chipmate.rag.embedding.model"].default).toBe("embedding-model")
    expect(properties["chipmate.rag.rerank.endpoint"].default).toBe("https://provider.example.test/v1/rerank")
    expect(properties["chipmate.rag.rerank.model"].default).toBe("rerank-model")
    expect(properties["chipmate.rag.allowedHosts"].default).toEqual(["provider.example.test"])
  })

  test("rejects incomplete local VSIX defaults", () => {
    expect(() => collectVsixLocalDefaultSettings({ provider: { apiBaseUrl: "https://provider.example.test/v1" } })).toThrow("provider.chatModel")
    expect(() => collectVsixLocalDefaultSettings({
      ...localDefaultsFixture(),
      rag: { ...localDefaultsFixture().rag, allowedHosts: [] },
    })).toThrow("non-empty string array")
  })

  test("runs the draw.io runtime gate before VSIX packaging", () => {
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "package-vsix.ts"), "utf8")
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))

    expect(manifest.scripts?.["verify:drawio-runtime"]).toBe("bun scripts/verify-drawio-runtime.ts")
    expect(script).toContain('run("bun", ["scripts/verify-drawio-runtime.ts"], repoRoot)')
    expect(script.indexOf('run("bun", ["scripts/verify-drawio-runtime.ts"], repoRoot)')).toBeLessThan(script.indexOf("writePackageManifest(packageJsonPath, packagedManifest)"))
  })
})

function localDefaultsFixture() {
  return {
    provider: {
      apiBaseUrl: "https://provider.example.test/v1",
      chatModel: "chat-model",
    },
    rag: {
      embedding: {
        endpoint: "https://provider.example.test/v1/embeddings",
        model: "embedding-model",
      },
      rerank: {
        endpoint: "https://provider.example.test/v1/rerank",
        model: "rerank-model",
      },
      allowedHosts: ["provider.example.test"],
    },
  }
}

function manifestFixture() {
  return {
    contributes: {
      configuration: {
        properties: {
          "chipmate.provider.apiBaseUrl": { default: "" },
          "chipmate.provider.chatModel": { default: "" },
          "chipmate.rag.embedding.endpoint": { default: "" },
          "chipmate.rag.embedding.model": { default: "existing-embedding-model" },
          "chipmate.rag.rerank.endpoint": { default: "" },
          "chipmate.rag.rerank.model": { default: "existing-rerank-model" },
          "chipmate.rag.allowedHosts": { default: [] },
        },
      },
    },
  }
}
