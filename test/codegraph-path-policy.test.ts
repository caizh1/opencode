import { describe, expect, test } from "bun:test"
import { isTestDirectoryPath, shouldIndexPath } from "../src/indexing-path-policy"

describe("code graph indexing path policy", () => {
  test("matches test directories by exact path segment only", () => {
    expect(isTestDirectoryPath("test/foo.c")).toBe(true)
    expect(isTestDirectoryPath("src/tests/foo.c")).toBe(true)
    expect(isTestDirectoryPath("a/Test/b.cpp")).toBe(true)
    expect(isTestDirectoryPath("a\\tests\\b.hpp")).toBe(true)

    expect(isTestDirectoryPath("contest/foo.c")).toBe(false)
    expect(isTestDirectoryPath("testdata/foo.c")).toBe(false)
    expect(isTestDirectoryPath("unit_test/foo.c")).toBe(false)
  })

  test("skips test directories by default and includes them when requested", () => {
    expect(shouldIndexPath("src/main.c")).toBe(true)
    expect(shouldIndexPath("src/tests/helper.c")).toBe(false)
    expect(shouldIndexPath("src/tests/helper.c", { indexTests: true })).toBe(true)
  })
})
