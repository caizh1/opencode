# OpenCode Remote VS Code Extension

Remote `opencode serve` client for VS Code.

This extension keeps the original terminal commands from the official OpenCode
VS Code extension, and adds a remote-first chat client that can send local VS
Code context to a remote OpenCode server.

## Configure

Open the OpenCode Remote view or run `OpenCode Remote: Connect to Remote OpenCode`, then enter:

- the remote server URL, for example `https://opencode.example.com`
- the Basic Auth username
- the Basic Auth password, stored in VS Code SecretStorage

Remote OpenCode never reads local files directly. The extension host collects
selected local context, diagnostics, optional git diff, and explicitly added
files, then sends that text to the remote server with the user question.
The current VS Code file is included by default when the `Current file` toggle
is enabled. Use `@` in the chat box to add extra files beyond the current file.

After connecting, the chat panel can load models from the remote server using
OpenCode's provider APIs. Pick `Use server default` to let the server choose, or
select a returned `provider/model`. If model discovery fails, use `Manual...`
and enter the same `provider/model` value you would use in OpenCode config.

Local-only guard is enabled by default. The extension tells OpenCode to use only
the local VS Code context sent in the prompt and blocks file-specific questions
when no local file content was captured. By default this is a prompt-level guard
and the extension does not force a remote agent, which keeps it compatible with
servers that have not configured custom agents.

For a harder server-side boundary, create a restricted agent on the remote
OpenCode server, keep `opencode.remote.localOnlyAgent` set to `vscode-local`,
then enable `opencode.remote.context.strictLocalOnlyAgent`. Do not enable strict
mode until the remote server has this agent; otherwise OpenCode may reject sends.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "vscode-local": {
      "description": "Answer VS Code remote-extension questions only from prompt-supplied local context.",
      "mode": "primary",
      "permission": {
        "read": "deny",
        "glob": "deny",
        "grep": "deny",
        "list": "deny",
        "bash": "deny",
        "edit": "deny",
        "external_directory": "deny",
        "lsp": "deny"
      }
    }
  }
}
```

Inline completion is available behind
`opencode.remote.completion.enabled` and is disabled by default.

## Development

```bash
bun install
bun run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

## Install Locally

```bash
bun run vsix
code --uninstall-extension local.opencode-remote
code --install-extension opencode-remote-0.0.14.vsix
```

After installing, run `Developer: Reload Window` in VS Code. This release uses a new view id to avoid VS Code keeping the old Explorer/OUTLINE placement cached.

No Marketplace publisher is required for local or internal `.vsix` installs.
