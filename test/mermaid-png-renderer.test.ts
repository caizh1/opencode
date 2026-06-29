import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 as pathWin32 } from "node:path"
import {
  discoverChrome,
  findChrome,
  formatChromeDiscoveryFailure,
  MermaidPngRenderError,
  renderMermaidToPng,
  type ChromeDiscoveryOptions,
} from "../src/mermaid-png-renderer"

describe("Mermaid PNG Chrome discovery", () => {
  test("uses quoted Windows CHROME_PATH when it points to an executable", () => {
    const chrome = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`
    const options: ChromeDiscoveryOptions = {
      platform: "win32",
      env: { CHROME_PATH: `"${chrome}"` },
      exists: (candidate) => candidate === chrome,
      runCommand: unexpectedCommandLookup,
    }

    expect(discoverChrome(options).path).toBe(chrome)
    expect(findChrome(options)).toBe(chrome)
  })

  test("discovers Chrome from standard Windows Program Files locations", () => {
    const programFiles = String.raw`C:\Program Files`
    const expected = pathWin32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe")
    const result = discoverChrome({
      platform: "win32",
      env: {
        ProgramFiles: programFiles,
        "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
        LOCALAPPDATA: String.raw`C:\Users\chipmate\AppData\Local`,
      },
      exists: (candidate) => candidate === expected,
      runCommand: unexpectedCommandLookup,
    })

    expect(result.path).toBe(expected)
    expect(result.checked.map((item) => item.source)).toContain("%ProgramFiles% Google Chrome")
  })

  test("discovers Edge from LOCALAPPDATA before falling back to command lookup", () => {
    const localAppData = String.raw`C:\Users\chipmate\AppData\Local`
    const expected = pathWin32.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
    const result = discoverChrome({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
      exists: (candidate) => candidate === expected,
      runCommand: unexpectedCommandLookup,
    })

    expect(result.path).toBe(expected)
    expect(result.checked.map((item) => item.source)).toContain("%LOCALAPPDATA% Microsoft Edge")
  })

  test("uses where.exe for Windows command discovery", () => {
    const chrome = String.raw`C:\Tools\Chrome\chrome.exe`
    const calls: Array<{ command: string; args: string[] }> = []
    const result = discoverChrome({
      platform: "win32",
      env: {},
      exists: () => false,
      runCommand: (command, args) => {
        calls.push({ command, args })
        if (command === "where.exe" && args[0] === "chrome.exe") {
          return { status: 0, stdout: `${chrome}\r\n` }
        }
        return { status: 1, stdout: "" }
      },
    })

    expect(result.path).toBe(chrome)
    expect(calls).toEqual([{ command: "where.exe", args: ["chrome.exe"] }])
    expect(result.checked.some((item) => item.source === "where.exe chrome.exe" && item.found === chrome)).toBe(true)
  })

  test("reports checked Windows candidates when no browser is found", () => {
    const result = discoverChrome({
      platform: "win32",
      env: {
        ProgramFiles: String.raw`C:\Program Files`,
        LOCALAPPDATA: String.raw`C:\Users\chipmate\AppData\Local`,
      },
      exists: () => false,
      runCommand: () => ({ status: 1, stdout: "" }),
    })
    const message = formatChromeDiscoveryFailure(result)

    expect(result.path).toBe("")
    expect(message).toContain("No Chrome/Edge executable found")
    expect(message).toContain("%ProgramFiles% Google Chrome")
    expect(message).toContain("%LOCALAPPDATA% Microsoft Edge")
    expect(message).toContain("where.exe chrome.exe")
    expect(message).toContain("where.exe msedge.exe")
  })

  test("keeps macOS direct app discovery without Windows fallback", () => {
    const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    const result = discoverChrome({
      platform: "darwin",
      env: {},
      exists: (candidate) => candidate === macChrome,
      runCommand: unexpectedCommandLookup,
    })

    expect(result.path).toBe(macChrome)
    expect(result.checked.some((item) => item.source.includes("%ProgramFiles%"))).toBe(false)
    expect(result.checked.some((item) => item.source.startsWith("where.exe"))).toBe(false)
  })

  test("keeps Linux command discovery on which", () => {
    const result = discoverChrome({
      platform: "linux",
      env: {},
      exists: () => false,
      runCommand: (command, args) => {
        if (command === "which" && args[0] === "google-chrome") return { status: 0, stdout: "/usr/bin/google-chrome\n" }
        return { status: 1, stdout: "" }
      },
    })

    expect(result.path).toBe("/usr/bin/google-chrome")
    expect(result.checked.some((item) => item.source === "which google-chrome")).toBe(true)
    expect(result.checked.some((item) => item.source.startsWith("where.exe"))).toBe(false)
  })
})

function unexpectedCommandLookup(): never {
  throw new Error("command lookup was not expected")
}

describe("Mermaid PNG render diagnostics", () => {
  test("reports missing packaged Mermaid runtime as a structured error", async () => {
    const root = await mkdtemp(join(tmpdir(), "chipmate-mermaid-missing-runtime-"))
    try {
      await expect(renderMermaidToPng({
        repoRoot: root,
        source: "flowchart TD\nA-->B",
      })).rejects.toMatchObject({
        diagnostic: expect.objectContaining({
          errorCode: "mermaid-runtime-missing",
          platform: process.platform,
          nodeVersion: process.version,
        }),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports no Chrome or Edge as a structured error with checked candidates", async () => {
    const root = await fakeMermaidRuntimeRoot()
    try {
      await expect(renderMermaidToPng({
        repoRoot: root,
        source: "flowchart TD\nA-->B",
        chromeDiscoveryOptions: {
          platform: "win32",
          env: {
            ProgramFiles: String.raw`C:\Program Files`,
            LOCALAPPDATA: String.raw`C:\Users\chipmate\AppData\Local`,
          },
          exists: () => false,
          runCommand: () => ({ status: 1, stdout: "" }),
        },
      })).rejects.toMatchObject({
        diagnostic: expect.objectContaining({
          errorCode: "chrome-not-found",
          checkedChromeCandidates: expect.arrayContaining([
            expect.stringContaining("%ProgramFiles% Google Chrome"),
            expect.stringContaining("where.exe chrome.exe"),
          ]),
        }),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports Chrome startup failure with bounded stderr details", async () => {
    if (process.platform === "win32") return
    const root = await fakeMermaidRuntimeRoot()
    const fakeChrome = join(root, "fake-chrome")
    const stderr = "mock chrome startup failed ".repeat(200)
    await writeFile(fakeChrome, `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`)
    await chmod(fakeChrome, 0o755)
    try {
      let caught: unknown
      try {
        await renderMermaidToPng({
        repoRoot: root,
        source: "flowchart TD\nA-->B",
        chromeDiscoveryOptions: {
          platform: process.platform,
          env: { CHROME_PATH: fakeChrome },
          exists: (candidate) => candidate === fakeChrome,
          runCommand: unexpectedCommandLookup,
        },
      })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(MermaidPngRenderError)
      const diagnostic = (caught as MermaidPngRenderError).diagnostic
      expect(diagnostic.errorCode).toBe("chrome-startup-failed")
      expect(diagnostic.stderrSnippet?.length ?? 0).toBeLessThanOrEqual(2000)
      expect(diagnostic.chromePath).toBe(fakeChrome)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function fakeMermaidRuntimeRoot() {
  const root = await mkdtemp(join(tmpdir(), "chipmate-mermaid-runtime-"))
  const runtimeDir = join(root, "node_modules", "mermaid", "dist")
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(join(runtimeDir, "mermaid.esm.min.mjs"), "export default {};")
  return root
}
