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
  await qwenAutocompleteSmoke()
}

async function activatesAndRegistersCommands() {
  const extension = vscode.extensions.getExtension("local.chipmate")
  assert.ok(extension, "local.chipmate extension should be available")

  await extension.activate()
  const commands = await vscode.commands.getCommands(true)

  assert.ok(commands.includes("chipmate.openChat"), "ChipMate openChat command should be registered")
  assert.ok(commands.includes("chipmate.newSession"), "ChipMate newSession command should be registered")
  assert.ok(commands.includes("chipmate.provider.setApiKey"), "ChipMate provider API key command should be registered")
  assert.ok(commands.includes("chipmate.codeGraph.index"), "ChipMate codeGraph index command should be registered")
  assert.equal(commands.includes("opencode.openTerminal"), false)
  assert.equal(commands.includes("chipmate.completion.runDirectAblation"), false)
  assert.equal(commands.includes("chipmate.completion.commitInlineSuggestion"), false)
}

async function opensRemoteChatCommand() {
  await vscode.commands.executeCommand("chipmate.openChat")
}

async function opensActivityBarContainer() {
  await vscode.commands.executeCommand("workbench.view.extension.chipmate")
  await vscode.commands.executeCommand("chipmate.sidebar.focus")
}

async function manifestHidesEditorTitleEntries() {
  const extension = vscode.extensions.getExtension("local.chipmate")
  assert.ok(extension, "local.chipmate extension should be available")

  const manifestPath = path.join(extension.extensionPath, "package.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))

  assert.equal(manifest.contributes?.menus?.["editor/title"], undefined)
}

async function manifestContributesActivityBarContainer() {
  const extension = vscode.extensions.getExtension("local.chipmate")
  assert.ok(extension, "local.chipmate extension should be available")

  const manifestPath = path.join(extension.extensionPath, "package.json")
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  const containers = manifest.contributes?.viewsContainers?.activitybar ?? []
  const explorerViews = manifest.contributes?.views?.explorer ?? []
  const chipmateViews = manifest.contributes?.views?.chipmate ?? []
  const newViewID = "chipmate.sidebar"
  const oldViewID = ["opencodeRemote", "chat"].join(".")

  assert.ok(
    containers.some(
      (container: { id?: string; icon?: string; title?: string }) =>
        container.id === "chipmate" &&
        container.title === "ChipMate" &&
        container.icon === "media/chipmate.svg",
    ),
    "ChipMate activity bar container should be contributed",
  )
  assert.equal(manifest.icon, "media/chipmate-icon.png")
  assert.equal(JSON.stringify(manifest).includes(oldViewID), false)
  assert.equal(manifest.activationEvents?.includes(`onView:${newViewID}`), true)
  assert.equal(explorerViews.some((view: { id?: string }) => view.id === newViewID), false)
  assert.equal(chipmateViews.some((view: { id?: string }) => view.id === newViewID), true)
  await fs.access(path.join(extension.extensionPath, "media", "chipmate-icon.png"))
  await fs.access(path.join(extension.extensionPath, "media", "chipmate.svg"))
}

async function qwenAutocompleteSmoke() {
  const extension = vscode.extensions.getExtension("local.chipmate")
  assert.ok(extension, "local.chipmate extension should be available")

  const commands = await vscode.commands.getCommands(true)
  assert.ok(commands.includes("chipmate.qwenAutocomplete.showLogs"), "qwen logs command should be registered")
  assert.ok(
    commands.includes("chipmate.qwenAutocomplete.exportDiagnostics"),
    "qwen diagnostics export command should be registered",
  )

  await fs.access(path.join(extension.extensionPath, "node_modules", "diff", "package.json"))
  await fs.access(path.join(extension.extensionPath, "node_modules", "js-tiktoken", "package.json"))
  await fs.access(path.join(extension.extensionPath, "node_modules", "web-tree-sitter", "tree-sitter.wasm"))
  await fs.access(path.join(extension.extensionPath, "vendor", "tree-sitter", "wasm", "tree-sitter-typescript.wasm"))
  await fs.access(
    path.join(
      extension.extensionPath,
      "vendor",
      "qwen-autocomplete",
      "tree-sitter",
      "import-queries",
      "typescript.scm",
    ),
  )
}
