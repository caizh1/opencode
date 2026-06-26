import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  inspectTerminalProjectContext,
  terminalProjectContextPrompt,
  terminalProjectContextSummaryLines,
} from "../src/agent-terminal-project-context"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })))
  tempDirs = []
})

describe("terminal project context inspection", () => {
  test("detects QEMU-style build files, docs, readme snippets, and build directories from a subdirectory", async () => {
    const root = await tempDir("chipmate-terminal-project-qemu-")
    await mkdir(join(root, "docs", "devel"), { recursive: true })
    await mkdir(join(root, "hw", "ufs"), { recursive: true })
    await mkdir(join(root, "build"))
    await writeFile(join(root, "configure"), "#!/bin/sh\n")
    await writeFile(join(root, "meson.build"), "project('qemu')\n")
    await writeFile(join(root, "README.rst"), "QEMU build instructions mention configure and ninja.\n")
    await writeFile(join(root, "docs", "devel", "build-system.rst"), "QEMU uses Meson and Ninja for builds.\n")

    const context = await inspectTerminalProjectContext({ cwd: join(root, "hw", "ufs") })

    expect(context.root).toBe(root)
    expect(context.relativeCwd).toBe("hw/ufs")
    expect(context.rootFiles).toEqual(["configure", "meson.build", "README.rst"])
    expect(context.buildFiles).toEqual(["configure", "meson.build"])
    expect(context.buildDirectories).toEqual(["build"])
    expect(context.docs).toContain("docs/devel/build-system.rst")
    expect(context.hints).toContain("configure script")
    expect(context.hints).toContain("Meson")
    expect(context.snippets.some((snippet) => snippet.path === "README.rst" && snippet.text.includes("configure"))).toBe(true)
    expect(terminalProjectContextSummaryLines(context).join("\n")).toContain("found: configure, meson.build, README.rst")
    expect(terminalProjectContextPrompt(context)).toContain("Project root:")
  })

  test("skips ignored docs directories and marks scanned docs as truncated", async () => {
    const root = await tempDir("chipmate-terminal-project-skip-")
    await mkdir(join(root, "docs", "node_modules"), { recursive: true })
    await mkdir(join(root, "docs", "out"), { recursive: true })
    await writeFile(join(root, "CMakeLists.txt"), "project(example)\n")
    await writeFile(join(root, "docs", "build-guide.rst"), "Build with cmake.\n")
    await writeFile(join(root, "docs", "install-guide.rst"), "Install with cmake --install.\n")
    await writeFile(join(root, "docs", "node_modules", "build-hidden.rst"), "ignore me\n")
    await writeFile(join(root, "docs", "out", "install-hidden.rst"), "ignore me\n")

    const context = await inspectTerminalProjectContext({ cwd: root, maxDocScan: 1 })

    expect(context.docs).toEqual(["docs/build-guide.rst"])
    expect(context.docs).not.toContain("docs/node_modules/build-hidden.rst")
    expect(context.docs).not.toContain("docs/out/install-hidden.rst")
    expect(context.truncated).toBe(true)
  })

  test("truncates large snippets while preserving useful project evidence", async () => {
    const root = await tempDir("chipmate-terminal-project-large-")
    await writeFile(join(root, "package.json"), "{\"scripts\":{\"build\":\"tsc\"}}\n")
    await writeFile(join(root, "README.md"), `${"build instructions ".repeat(40)}\n`)

    const context = await inspectTerminalProjectContext({ cwd: root, maxSnippetBytes: 48 })

    expect(context.buildFiles).toEqual(["package.json"])
    expect(context.snippets[0]?.path).toBe("README.md")
    expect(context.snippets[0]?.truncated).toBe(true)
    expect(context.truncated).toBe(true)
  })
})

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
