import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

export async function run() {
  await activatesAndRegistersCommands()
  await opensRemoteChatCommand()
  await opensActivityBarContainer()
  await manifestHidesEditorTitleEntries()
  await manifestContributesActivityBarContainer()
}

async function activatesAndRegistersCommands() {
  const extension = vscode.extensions.getExtension("local.opencode-remote")
  assert.ok(extension, "local.opencode-remote extension should be available")

  await extension.activate()
  const commands = await vscode.commands.getCommands(true)

  assert.ok(commands.includes("opencode.remote.openChat"), "remote openChat command should be registered")
  assert.ok(commands.includes("opencode.remote.connect"), "remote connect command should be registered")
  assert.ok(commands.includes("opencode.remote.testConnection"), "remote testConnection command should be registered")
  assert.ok(commands.includes("opencode.openTerminal"), "local openTerminal command should be registered")
  assert.ok(commands.includes("opencode.openNewTerminal"), "local openNewTerminal command should be registered")
}

async function opensRemoteChatCommand() {
  await vscode.commands.executeCommand("opencode.remote.openChat")
}

async function opensActivityBarContainer() {
  await vscode.commands.executeCommand("workbench.view.extension.opencodeRemote")
  await vscode.commands.executeCommand("opencodeRemote.sidebar.focus")
}

async function manifestHidesEditorTitleEntries() {
  const extension = vscode.extensions.getExtension("local.opencode-remote")
  assert.ok(extension, "local.opencode-remote extension should be available")

  const manifestPath = path.join(extension.extensionPath, "package.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))

  assert.equal(manifest.contributes?.menus?.["editor/title"], undefined)
}

async function manifestContributesActivityBarContainer() {
  const extension = vscode.extensions.getExtension("local.opencode-remote")
  assert.ok(extension, "local.opencode-remote extension should be available")

  const manifestPath = path.join(extension.extensionPath, "package.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  const containers = manifest.contributes?.viewsContainers?.activitybar ?? []
  const explorerViews = manifest.contributes?.views?.explorer ?? []
  const opencodeViews = manifest.contributes?.views?.opencodeRemote ?? []
  const newViewID = "opencodeRemote.sidebar"
  const oldViewID = ["opencodeRemote", "chat"].join(".")

  assert.ok(
    containers.some(
      (container: { id?: string; icon?: string; title?: string }) =>
        container.id === "opencodeRemote" &&
        container.title === "OpenCode" &&
        container.icon === "media/opencode.svg",
    ),
    "OpenCode activity bar container should be contributed",
  )
  assert.equal(JSON.stringify(manifest).includes(oldViewID), false)
  assert.equal(manifest.activationEvents?.includes(`onView:${newViewID}`), true)
  assert.equal(explorerViews.some((view: { id?: string }) => view.id === newViewID), false)
  assert.equal(opencodeViews.some((view: { id?: string }) => view.id === newViewID), true)
  await fs.access(path.join(extension.extensionPath, "media", "opencode.svg"))
}
