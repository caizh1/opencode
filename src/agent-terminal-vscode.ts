import * as vscode from "vscode"
import { AgentTerminalPty, type AgentTerminalClient } from "./agent-terminal"
import { CHIPMATE_AGENT_TERMINAL_PROFILE_ID, CHIPMATE_COMMANDS } from "./chipmate-constants"
import { classifyCommandRisk } from "./permissions"

const TERMINAL_NAME = "ChipMate Agent Terminal"

type AgentTerminalOutput = Pick<vscode.OutputChannel, "appendLine">

export function registerAgentTerminal(input: {
  context: vscode.ExtensionContext
  output: AgentTerminalOutput
  getClient: () => AgentTerminalClient | undefined
}) {
  const createOptions = (): vscode.ExtensionTerminalOptions => ({
    name: TERMINAL_NAME,
    pty: new AgentTerminalPty({
      getClient: input.getClient,
      output: input.output,
      initialCwd: workspaceRoot(),
      classifyCommandRisk,
      createEventEmitter: <T>() => new vscode.EventEmitter<T>(),
    }) as vscode.Pseudoterminal,
    iconPath: new vscode.ThemeIcon("terminal"),
    isTransient: true,
  })

  input.context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(CHIPMATE_AGENT_TERMINAL_PROFILE_ID, {
      provideTerminalProfile: () => new vscode.TerminalProfile(createOptions()),
    }),
    vscode.commands.registerCommand(CHIPMATE_COMMANDS.openAgentTerminal, () => {
      const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME)
      if (existing) {
        input.output.appendLine("[agent-terminal] focused existing ChipMate Agent Terminal")
        existing.show()
        return
      }
      const terminal = vscode.window.createTerminal(createOptions())
      input.output.appendLine("[agent-terminal] created ChipMate Agent Terminal")
      terminal.show()
    }),
  )
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
}
