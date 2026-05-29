import * as vscode from "vscode"

const TERMINAL_NAME = "opencode"

export function registerLocalTerminalCommands(context: vscode.ExtensionContext) {
  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal(context)
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    const existingTerminal = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal(context)
  })

  const addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) return

    const terminal = vscode.window.activeTerminal
    if (!terminal) return

    if (terminal.name === TERMINAL_NAME) {
      const options = terminal.creationOptions as vscode.TerminalOptions
      const port = options.env?.["_EXTENSION_OPENCODE_PORT"]
      if (port) {
        await appendPrompt(Number(port), fileRef)
      } else {
        terminal.sendText(fileRef, false)
      }
      terminal.show()
    }
  })

  context.subscriptions.push(openNewTerminalDisposable, openTerminalDisposable, addFilepathDisposable)
}

async function openTerminal(context: vscode.ExtensionContext) {
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    location: {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    },
    env: {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
    },
  })

  terminal.show()
  terminal.sendText(`opencode --port ${port}`)

  const fileRef = getActiveFile()
  if (!fileRef) return

  let tries = 10
  let connected = false
  do {
    await delay(200)
    try {
      await fetch(`http://localhost:${port}/app`)
      connected = true
      break
    } catch {
      tries--
    }
  } while (tries > 0)

  if (connected) {
    await appendPrompt(port, `In ${fileRef}`)
    terminal.show()
  }

  context.subscriptions.push(terminal)
}

async function appendPrompt(port: number, text: string) {
  await fetch(`http://localhost:${port}/tui/append-prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  })
}

export function getActiveFile() {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor) return

  const document = activeEditor.document
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!workspaceFolder) return

  const relativePath = vscode.workspace.asRelativePath(document.uri)
  let filepathWithAt = `@${relativePath}`

  const selection = activeEditor.selection
  if (!selection.isEmpty) {
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1

    if (startLine === endLine) {
      filepathWithAt += `#L${startLine}`
    } else {
      filepathWithAt += `#L${startLine}-${endLine}`
    }
  }

  return filepathWithAt
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
