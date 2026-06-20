import { describe, expect, test } from "bun:test"
import { parsePackageVsixCliArgs, resolvePackageVsixVersion } from "../scripts/package-vsix"

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
})
