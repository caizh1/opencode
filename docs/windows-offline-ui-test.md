# Windows Offline UI Runner

This workflow packages a runner-only Windows UI automation bundle for a target host that already has ChipMate installed in real VS Code. The bundle does not contain a VSIX and does not install or upgrade the extension.

## Build the Runner Bundle

```bash
bun run package
bun run test:ui-windows:bundle -- --node-win-x64 /path/to/node-win-x64 --out ./outputs
bun run test:ui-windows:verify-bundle -- --bundle ./outputs/chipmate-ui-runner-windows-<YYYYMMDD-HHmm>.zip --strict
```

The Windows Node directory must contain `node.exe`. The generated Windows scripts require the bundled `bin/node-win-x64/node.exe` and never fall back to system Node.

If the Windows host may not already have VS Code, build a larger handoff bundle:

```bash
bun run test:ui-windows:bundle -- --node-win-x64 /path/to/node-win-x64 --include-vscode /path/to/VSCode-win32-x64
```

## Run on Windows

On the offline Windows target:

```powershell
Copy-Item .\test-config.example.json .\test-config.json
notepad .\test-config.json
.\run-chipmate-ui-smoke.ps1 -Config .\test-config.json
.\run-chipmate-ui-full.ps1 -Config .\test-config.json
.\collect-chipmate-ui-report.ps1
```

The default runner uses `installMode=already-installed` and `profileMode=direct-real`. It starts real VS Code without `--user-data-dir` or `--extensions-dir`, checks `code --list-extensions --show-versions` for `local.chipmate`, discovers the target top-level VS Code window by process/path/workspace evidence, and tests the currently installed extension.

## Coverage Status

The implemented first-stage runner validates:

- real VS Code CLI and installed ChipMate visibility
- direct real-profile startup
- target VS Code window discovery with `window-candidates.json`
- workspace-level settings injection for the fixture workspace
- real VS Code window launch
- ChipMate chat and Output commands
- editor-driven inline completion trigger
- CodeGraph/RAG/Document RAG command surfaces
- AI comments command surfaces
- Agent Terminal command surface
- Output, Extension Host, and globalStorage summary collection from the real profile
- report redaction and zip-level runner bundle verification

Deep webview DOM actions such as typing into the chat composer, clicking review-panel accept/reject buttons, and asserting terminal buffer text are intentionally reported as skipped until the bundle includes a pre-resolved WebDriver/ExTester dependency set under `runner/node_modules`, `runner/drivers`, and `runner/cache`.

## Reports

Each run writes:

```text
reports/<run-id>/
  summary.md
  summary.json
  environment.json
  installed-chipmate.json
  installed-extensions.txt
  vscode-version.txt
  vscode-cli-commands.json
  runner-bundle.json
  window-candidates.json
  test-results.json
  logs/
  screenshots/
  globalStorage-summary.json
  redaction-report.json
```

Analyze only the returned Windows report when debugging target-machine RAG, globalStorage, SecretStorage, Extension Host, or installed extension behavior.
