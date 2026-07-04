import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { platform } from "node:os"
import { dirname } from "node:path"

export type UiDriverResult = {
  ok: boolean
  commandLine: string
  stdout: string
  stderr: string
  status: number | null
}

export type UiDriverOptions = {
  codeCmd: string
  userDataDir: string
  extensionsDir: string
  workspace: string
  timeoutMs: number
  artifactDir: string
}

export class VsCodeUiDriver {
  constructor(private readonly options: UiDriverOptions) {}

  openView(commandId: string) {
    return this.codeCommand(commandId)
  }

  openWorkspace(workspace = this.options.workspace) {
    return this.run(this.options.codeCmd, [
      "--reuse-window",
      "--user-data-dir",
      this.options.userDataDir,
      "--extensions-dir",
      this.options.extensionsDir,
      workspace,
    ])
  }

  commandPalette(commandId: string) {
    return this.codeCommand(commandId)
  }

  press(keys: string) {
    if (platform() !== "darwin") return this.skipped(`press(${keys})`, "non-macos")
    return this.osascript(`tell application "System Events" to keystroke ${JSON.stringify(keys)}`)
  }

  type(text: string) {
    if (platform() !== "darwin") return this.skipped("type(text)", "non-macos")
    return this.osascript(`tell application "System Events" to keystroke ${JSON.stringify(text)}`)
  }

  clickMenu(menuPath: string[]) {
    if (platform() !== "darwin") return this.skipped(`clickMenu(${menuPath.join(" > ")})`, "non-macos")
    const [root, ...rest] = menuPath
    if (!root || rest.length === 0) return this.skipped("clickMenu", "menu path too short")
    const chain = rest.map((item) => `menu item ${JSON.stringify(item)} of menu 1`).join(" of ")
    return this.osascript(`tell application "System Events" to tell process "Code" to click ${chain} of menu bar item ${JSON.stringify(root)} of menu bar 1`)
  }

  screenshot(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    if (platform() !== "darwin") return this.skipped(`screenshot(${path})`, "non-macos")
    const result = this.run("screencapture", ["-x", path], 10_000)
    return { ...result, ok: result.status === 0 && existsSync(path) }
  }

  writeSnapshot(path: string, payload: unknown) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`)
  }

  private codeCommand(commandId: string) {
    return this.run(this.options.codeCmd, [
      "--reuse-window",
      "--user-data-dir",
      this.options.userDataDir,
      "--extensions-dir",
      this.options.extensionsDir,
      "--command",
      commandId,
    ])
  }

  private osascript(script: string) {
    return this.run("osascript", ["-e", script], this.options.timeoutMs)
  }

  private run(command: string, args: string[], timeoutMs = this.options.timeoutMs): UiDriverResult {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, shell: false })
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
      commandLine: [command, ...args.map((arg) => arg.includes(" ") ? JSON.stringify(arg) : arg)].join(" "),
    }
  }

  private skipped(commandLine: string, reason: string): UiDriverResult {
    return { ok: false, status: null, stdout: reason, stderr: "", commandLine }
  }
}
