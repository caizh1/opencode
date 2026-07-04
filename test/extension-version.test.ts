import { describe, expect, test } from "bun:test"
import { compareExtensionVersions, shouldPromptReloadForInstalledVersion } from "../src/extension-version"

describe("extension version comparison", () => {
  test("orders build-number prerelease versions for reload prompts", () => {
    expect(compareExtensionVersions("0.1.0-build.2", "0.1.0-build.1")).toBeGreaterThan(0)
    expect(shouldPromptReloadForInstalledVersion("0.1.0-build.2", "0.1.0-build.1")).toBe(true)
  })

  test("orders stable releases above build-number prereleases", () => {
    expect(compareExtensionVersions("0.1.0", "0.1.0-build.9")).toBeGreaterThan(0)
    expect(shouldPromptReloadForInstalledVersion("0.1.0", "0.1.0-build.9")).toBe(true)
  })

  test("orders later core releases above older builds", () => {
    expect(compareExtensionVersions("0.1.2-build.1", "0.1.0-build.99")).toBeGreaterThan(0)
    expect(shouldPromptReloadForInstalledVersion("0.1.2-build.1", "0.1.0-build.99")).toBe(true)
  })

  test("does not prompt for identical versions", () => {
    expect(compareExtensionVersions("0.1.0-build.1", "0.1.0-build.1")).toBe(0)
    expect(shouldPromptReloadForInstalledVersion("0.1.0-build.1", "0.1.0-build.1")).toBe(false)
  })

  test("orders multi-part prerelease identifiers for manifest latest checks", () => {
    expect(compareExtensionVersions("0.2.0-build.27", "0.2.0-build.26")).toBeGreaterThan(0)
    expect(compareExtensionVersions("0.2.0-build.27", "0.2.0-alpha.99")).toBeGreaterThan(0)
    expect(compareExtensionVersions("0.2.0-build.27", "0.2.0")).toBeLessThan(0)
  })

  test("fails closed toward prompting when installed metadata is unparsable", () => {
    expect(compareExtensionVersions("not-a-version", "0.2.0-build.26")).toBeGreaterThan(0)
    expect(shouldPromptReloadForInstalledVersion("not-a-version", "0.2.0-build.26")).toBe(true)
  })
})
