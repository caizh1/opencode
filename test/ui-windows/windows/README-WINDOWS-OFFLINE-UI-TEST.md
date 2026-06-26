# ChipMate Windows Offline UI Runner

这份包用于在离线 Windows 真实 VS Code 环境中直接测试已安装的 ChipMate。包内不包含 VSIX，不会安装或升级插件，也不会下载 Node、npm 包、driver、fixtures 或扩展运行时依赖。

请使用 `chipmate-ui-runner-windows-*.zip` 或预填配置的 `chipmate-ui-runner-windows-caizh-*.zip`。不要继续用旧的 `chipmate-ui-test-windows-0.1.0-build.x` 包验证当前 UI runner；旧包可能仍包含 VSIX/build 绑定流程和过时的 UI 驱动。

## 前提

- 目标 Windows 已安装真实 VS Code。
- 目标 Windows 已安装 ChipMate，默认扩展 ID 是 `local.chipmate`。
- 包内必须存在 `bin\node-win-x64\node.exe`。

## 使用步骤

1. 解压整个 zip 到目标 Windows 机器，例如 `D:\chipmate-ui-runner`.
2. 复制 `test-config.example.json` 为 `test-config.json`。
3. 按目标机器实际情况填写 `realUserDataDir`、`realExtensionsDir` 和内网 provider 配置。`codeCmd` 默认可以保持 `"auto"`。
4. 完全断网或先做快速验证时运行 smoke：

```powershell
.\run-chipmate-ui-smoke.ps1 -Config .\test-config.json
```

5. 内网 provider/embedding/rerank 可达时运行 full：

```powershell
.\run-chipmate-ui-full.ps1 -Config .\test-config.json
```

6. 打包回传报告：

```powershell
.\collect-chipmate-ui-report.ps1
```

## Profile 行为

默认 `profileMode=direct-real`。runner 会直接启动目标机真实 VS Code profile，不传 `--user-data-dir` 或 `--extensions-dir`，因此测试的是当前已安装 ChipMate 和真实 globalStorage 状态。测试只写 workspace 级 `.vscode/settings.json`，但插件自身仍可能写入真实 history、SecretStorage 或 globalStorage。

## 看不到 UI 操作时

脚本必须从 Windows 交互式桌面会话运行。不要通过 WinRM、SSH、计划任务、服务会话或锁屏后的远程后台会话运行；这些环境通常不能把键盘事件发送到真实 VS Code 窗口。

runner 启动 VS Code 前会记录当前可见窗口，启动后会枚举真实 Windows 顶层窗口并按 `codeCmd` 安装目录、workspace 标题提示和 `windowActivation` 配置定位目标窗口。它不依赖固定的 “Visual Studio Code” 窗口名。

当 `codeCmd` 为 `"auto"`，或者配置的 `code.cmd` 不存在/不可运行时，runner 会自动尝试 `where.exe code.cmd`、`where.exe code`、`%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd`、`%ProgramFiles%\Microsoft VS Code\bin\code.cmd` 和 `%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd`。发现过程会写入 `vscode-discovery.json`。

默认会等待并定位窗口最多 `windowActivation.timeoutMs`，再额外等待 `timeouts.startupMs` 让插件激活。若无法唯一定位窗口，测试会失败，并在 `window-candidates.json` 中写出所有候选窗口的 `hwnd`、`pid`、`processName`、`processPath`、`windowTitle` 和匹配分数。

每个命令面板步骤都会先激活目标 VS Code 窗口并校验前台窗口 PID。runner 优先使用 Windows UIAutomation 找 command palette 输入框；如果目标 VS Code/Electron 没暴露输入框，但前台 PID 仍确认是目标 VS Code，会使用 guarded keyboard fallback 粘贴 `>ChipMate: ...` 并回车。每次粘贴和回车前都会重新校验前台窗口，避免把命令文本打进 PowerShell 或其它窗口。

如果目标机器是企业版、Insiders 或窗口标题被改造，可以在 `test-config.json` 中设置：

```json
"windowActivation": {
  "strategy": "auto",
  "processNameRegex": "^Code",
  "titleRegex": "你的 VS Code 标题关键字",
  "workspaceTitleHint": "smoke",
  "timeoutMs": 45000
}
```

## 报告

报告会生成在 `reports\<run-id>\`，包括：

- `summary.md`
- `summary.json`
- `environment.json`
- `installed-chipmate.json`
- `vscode-version.txt`
- `installed-extensions.txt`
- `vscode-cli-commands.json`
- `vscode-discovery.json`
- `window-candidates.json`
- `ui-steps.json`
- `functional-checks.json`
- `test-results.json`
- `logs\`
- `screenshots\`
- `globalStorage-summary.json`
- `redaction-report.json`

报告会尝试脱敏 API key、Authorization header、常见 secret token、Windows 用户名、用户目录和主机名。

`functional-checks.json` 是功能断言矩阵：每条记录都会说明测试意图、真实用户动作、期望、实际观察和证据路径。`summary.md` 的 “Validated Functional Checks” 表会同步展示这些断言，避免只看到命令执行成功而不知道具体测了什么。
